
"use server";

import { unstable_cache } from 'next/cache';
import { google } from 'googleapis';
import fs from 'fs';
import path from 'path';

const getSheetData = unstable_cache(
    async (url: string) => {
        if (!url) {
            return { error: 'Please provide a Google Sheets URL.' };
        }

        const sheetIdRegex = /spreadsheets\/d\/([a-zA-Z0-9-_]+)/;
        const match = url.match(sheetIdRegex);

        if (!match || !match[1]) {
            return { error: 'Invalid Google Sheets URL format. Please use a valid share link.' };
        }

        const sheetId = match[1];
        const exportUrl = `https://docs.google.com/spreadsheets/d/${sheetId}/export?format=csv`;

        try {
            const response = await fetch(exportUrl, { next: { revalidate: 3600 } }); // Cache for 1 hour
            if (!response.ok) {
                throw new Error(`Failed to fetch sheet. Status: ${response.status}. Make sure the sheet sharing setting is "Anyone with the link".`);
            }
            const csvText = await response.text();
            if (!csvText) {
                return { error: 'The Google Sheet appears to be empty or could not be read.' };
            }
            
            const lines = csvText.trim().split(/\r\n|\n/);
            const headersLine = lines.shift() || '';
            const headers = headersLine.split(',').map(h => h.trim().replace(/^"|"$/g, ''));
            
            const data = lines.map(line => {
                const values = line.split(/,(?=(?:(?:[^"]*"){2})*[^"]*$)/);
                const row: Record<string, string> = {};
                headers.forEach((header, i) => {
                    row[header] = (values[i] || '').trim().replace(/^"|"$/g, '');
                });
                return row;
            }).filter(row => Object.values(row).some(val => val !== ''));

            if (data.length === 0) {
                return { error: 'No data found in the sheet (after the header row).' };
            }

            return { data, headers };

        } catch (error) {
            console.error(error);
            return { error: error instanceof Error ? error.message : 'An unknown error occurred while fetching the data.' };
        }
    },
    ['sheet-data'],
    {
        tags: ['sheet-data']
    }
)

export async function fetchSheetData(url: string) {
    return getSheetData(url);
}

const getGoogleSheetsClient = () => {
    let credentials;
    // Vercel/Production environment: Read from environment variable
    if (process.env.GCP_CREDENTIALS) {
        try {
            credentials = JSON.parse(process.env.GCP_CREDENTIALS);
        } catch (error) {
            console.error('Error parsing GCP_CREDENTIALS from environment variable:', error);
            throw new Error('Could not parse Google Cloud credentials from environment variable.');
        }
    } 
    // Local development environment: Read from file
    else {
        try {
            const filePath = path.join(process.cwd(), 'src', 'lib', 'gcp-credentials.json');
            const fileContent = fs.readFileSync(filePath, 'utf-8');
            credentials = JSON.parse(fileContent);
        } catch (error) {
            console.error('Error reading or parsing credentials file:', error);
            throw new Error('Could not load Google Cloud credentials. Make sure src/lib/gcp-credentials.json exists for local development.');
        }
    }
    
    const clientEmail = credentials.client_email;
    const privateKey = credentials.private_key;

    if (!clientEmail || !privateKey) {
        throw new Error('Google Cloud credentials are not configured correctly.');
    }

    const auth = new google.auth.GoogleAuth({
        credentials: {
            client_email: clientEmail,
            private_key: privateKey.replace(/\\n/g, '\n'),
        },
        scopes: ['https://www.googleapis.com/auth/spreadsheets'],
    });

    return google.sheets({ version: 'v4', auth });
}

export async function getSpreadsheetTitle(sheetUrl: string) {
    if (!sheetUrl) {
        return { error: "URL is empty. Please provide a Google Sheet URL." };
    }

    const sheetIdRegex = /spreadsheets\/d\/([a-zA-Z0-T-_]+)/;
    const match = sheetUrl.match(sheetIdRegex);
    if (!match || !match[1]) {
        return { error: 'Invalid Google Sheets URL format.' };
    }
    const spreadsheetId = match[1];

    try {
        const sheets = getGoogleSheetsClient();
        const response = await sheets.spreadsheets.get({
            spreadsheetId,
            fields: 'properties.title',
        });

        const title = response.data.properties?.title;

        if (!title) {
            return { error: "Could not retrieve the spreadsheet title." };
        }

        return { success: true, title };
    } catch (error: any) {
        console.error('Failed to get spreadsheet title:', error.message);
        const apiError = error.errors?.[0]?.message || error.message || 'An unknown error occurred while analyzing the sheet.';
        return { error: `Analysis Failed: ${apiError}` };
    }
}


async function getSheetRowMap(sheets: any, spreadsheetId: string, sheetName: string) {
    const rangeToRead = `${sheetName}!G:T`; // Read from Status (G) to Ticket OP (T)
    const response = await sheets.spreadsheets.values.get({
        spreadsheetId,
        range: rangeToRead,
    });

    const sheetRows = response.data.values;
    if (!sheetRows || sheetRows.length === 0) {
        return {};
    }

    const ticketNumberRegex = /#(\d+)/;
    const rowMap: Record<string, { rowIndex: number, currentStatus: string; currentTicketOp: string; title: string }> = {};
    sheetRows.forEach((row, index) => {
        const currentStatus = row[0] || ''; // Column G
        const detailCase = row[6]; // Column M (G is 0, so M is 6)
        const currentTicketOp = row[13] || ''; // Column T (G is 0, so T is 13)

        if (typeof detailCase === 'string') {
            const match = detailCase.match(ticketNumberRegex);
            if (match && match[1]) {
                const ticketNumber = match[1];
                rowMap[ticketNumber] = {
                    rowIndex: index + 1, // 1-based index
                    currentStatus: currentStatus,
                    currentTicketOp: currentTicketOp,
                    title: detailCase,
                };
            }
        }
    });
    return rowMap;
}

export async function getUpdatePreview(
    data: { rows: Record<string, any>[] },
    sheetUrl: string
) {
    if (!data || data.rows.length === 0) {
        return { error: 'No data provided to preview.' };
    }

    const sheetIdRegex = /spreadsheets\/d\/([a-zA-Z0-T-_]+)/;
    const match = sheetUrl.match(sheetIdRegex);
    if (!match || !match[1]) {
        return { error: 'Invalid Google Sheets URL format.' };
    }
    const spreadsheetId = match[1];
    const sheetName = 'All Case';

    try {
        const sheets = getGoogleSheetsClient();
        const rowMap = await getSheetRowMap(sheets, spreadsheetId, sheetName);
        
        const changesToPreview: { title: string, oldStatus: string, newStatus: string, oldTicketOp: string, newTicketOp: string }[] = [];
        const ticketNumberRegex = /#(\d+)/;

        for (const appRow of data.rows) {
            const detailCase = appRow['Title'];
            const newStatus = appRow['Status'];
            const newTicketOp = appRow['Ticket OP'];

            if (typeof detailCase === 'string') {
                const match = detailCase.match(ticketNumberRegex);
                if (match && match[1]) {
                    const ticketNumber = match[1];
                    const sheetRowInfo = rowMap[ticketNumber];
                    
                    if (sheetRowInfo && (sheetRowInfo.currentStatus !== newStatus || sheetRowInfo.currentTicketOp !== newTicketOp)) {
                        changesToPreview.push({
                            title: sheetRowInfo.title,
                            oldStatus: sheetRowInfo.currentStatus,
                            newStatus: newStatus,
                            oldTicketOp: sheetRowInfo.currentTicketOp,
                            newTicketOp: newTicketOp,
                        });
                    }
                }
            }
        }
        
        return { success: true, changes: changesToPreview };

    } catch (error: any) {
        console.error('Failed to get update preview:', error.message);
        const apiError = error.errors?.[0]?.message || error.message || 'An unknown error occurred during preview generation.';
        return { error: apiError };
    }
}


export async function updateSheetStatus(
    data: { rows: Record<string, any>[] },
    sheetUrl: string
) {
     if (!data || data.rows.length === 0) {
        return { error: 'No data provided to update.' };
    }
    
    const sheetIdRegex = /spreadsheets\/d\/([a-zA-Z0-T-_]+)/;
    const match = sheetUrl.match(sheetIdRegex);
    if (!match || !match[1]) {
        return { error: 'Invalid Google Sheets URL format.' };
    }
    const spreadsheetId = match[1];
    const sheetName = 'All Case';

    try {
        const sheets = getGoogleSheetsClient();
        const rowMap = await getSheetRowMap(sheets, spreadsheetId, sheetName);

        const updateRequests = [];
        const updatedRows: { title: string, oldStatus: string, newStatus: string, rowIndex: number, oldTicketOp: string, newTicketOp: string }[] = [];
        const ticketNumberRegex = /#(\d+)/;
        
        for (const appRow of data.rows) {
            const detailCase = appRow['Title'];
            const newStatus = appRow['Status'];
            const newTicketOp = appRow['Ticket OP'];


            if (typeof detailCase === 'string') {
                const match = detailCase.match(ticketNumberRegex);
                if (match && match[1]) {
                    const ticketNumber = match[1];
                    const sheetRowInfo = rowMap[ticketNumber];
                    
                    if (sheetRowInfo && (sheetRowInfo.currentStatus !== newStatus || sheetRowInfo.currentTicketOp !== newTicketOp)) {
                         updateRequests.push(
                            { // Status
                                range: `${sheetName}!G${sheetRowInfo.rowIndex}`,
                                values: [[newStatus]],
                            },
                            { // Ticket OP
                                range: `${sheetName}!T${sheetRowInfo.rowIndex}`,
                                values: [[newTicketOp]],
                            }
                        );
                        updatedRows.push({ 
                            title: detailCase, 
                            oldStatus: sheetRowInfo.currentStatus, 
                            newStatus, 
                            rowIndex: sheetRowInfo.rowIndex,
                            oldTicketOp: sheetRowInfo.currentTicketOp,
                            newTicketOp
                        });
                    }
                }
            }
        }
        
        if (updateRequests.length === 0) {
            return { success: true, message: 'No changes detected. Everything is up-to-date.', updatedRows: [] };
        }
        
        await sheets.spreadsheets.values.batchUpdate({
            spreadsheetId,
            requestBody: {
                valueInputOption: 'USER_ENTERED',
                data: updateRequests,
            },
        });
        
        return { success: true, message: `Successfully updated ${updatedRows.length} rows.`, updatedRows, operationType: 'UPDATE' };

    } catch (error: any) {
        console.error('Failed to update sheet status:', error.message);
        const apiError = error.errors?.[0]?.message || error.message || 'An unknown error occurred during sheet update.';
        return { error: apiError };
    }
}

async function getSheetIdByName(sheets: any, spreadsheetId: string, sheetName: string) {
    const response = await sheets.spreadsheets.get({
        spreadsheetId,
        fields: 'sheets.properties.sheetId,sheets.properties.title',
    });
    const sheet = response.data.sheets?.find(
        (s: any) => s.properties?.title?.trim().toLowerCase() === sheetName.trim().toLowerCase()
    );
    return sheet?.properties?.sheetId ?? null;
}

export async function importToSheet(
    data: { headers: string[], rows: Record<string, any>[] },
    sheetUrl: string
) {
    const sheetIdRegex = /spreadsheets\/d\/([a-zA-Z0-T-_]+)/;
    const match = sheetUrl.match(sheetIdRegex);
    if (!match || !match[1]) {
        return { error: 'Invalid Google Sheets URL format.' };
    }
    const spreadsheetId = match[1];
    const sheetName = 'All Case';

    try {
        const sheets = getGoogleSheetsClient();

        // 1. Get sheetId for Undo operation later
        const sheetId = await getSheetIdByName(sheets, spreadsheetId, sheetName);
        if (sheetId === null) {
            return { error: `The target sheet named "${sheetName}" was not found in the spreadsheet.` };
        }

        // 2. Find existing titles to avoid duplicates (from column M)
        const titleRange = `${sheetName}!M:M`;
        const titleResponse = await sheets.spreadsheets.values.get({
            spreadsheetId,
            range: titleRange,
        });
        const existingTitles = new Set(titleResponse.data.values ? titleResponse.data.values.flat() : []);
        
        const newRows = [];
        const duplicateRows = [];
        for (const row of data.rows) {
            const title = row['Title'];
            if (title && !existingTitles.has(title)) {
                newRows.push(row);
            } else if (title) {
                duplicateRows.push(title);
            }
        }
        
        if (newRows.length === 0) {
            return {
                success: true,
                message: 'No new data to import.',
                importedCount: 0,
                duplicateCount: duplicateRows.length,
                duplicates: duplicateRows
            };
        }

        // 3. Prepare data for the append operation.
        // The final structure should have data up to column T.
        // Columns A-D are empty.
        // E-O are from the main headers.
        // P-S are empty.
        // T is "Ticket OP".
        const valuesToAppend = newRows.map(row => {
            const mainData = data.headers
                .filter(h => h.toLowerCase() !== 'ticket op') // Exclude Ticket OP from main mapping
                .map(header => row[header] || '');

            return [
                '', '', '', '', // A-D
                ...mainData,   // E-O (11 columns)
                '', '', '', '', // P-S
                row['Ticket OP'] || '' // T
            ];
        });

        // 4. Use `append` to add the new rows. This will automatically add new rows if the grid is full.
        const appendResult = await sheets.spreadsheets.values.append({
            spreadsheetId,
            range: sheetName, // Append to the entire sheet, API finds the last row
            valueInputOption: 'USER_ENTERED',
            requestBody: {
                values: valuesToAppend,
            },
        });

        // 5. Prepare data for the 'Undo' action
        const updatedRange = appendResult.data.updates?.updatedRange;
        if (!updatedRange) {
            return {
                success: true,
                message: `Import complete, but could not get range for undo action.`,
                importedCount: newRows.length,
                duplicateCount: duplicateRows.length,
                duplicates: duplicateRows,
            };
        }
        
        // Regex to extract start row from a range like 'All Case'!A2414:T2414
        const rangeRegex = /!A(\d+):/; 
        const matchResult = updatedRange.match(rangeRegex);
        if (!matchResult || !matchResult[1]) {
             return {
                success: true,
                message: `Import complete, but could not parse the updated range for undo action.`,
                importedCount: newRows.length,
                duplicateCount: duplicateRows.length,
                duplicates: duplicateRows,
            };
        }
        const startRowIndex = parseInt(matchResult[1], 10) -1; // 0-indexed for API

        const undoData = {
            operationType: 'IMPORT',
            spreadsheetId,
            sheetId,
            startIndex: startRowIndex,
            count: newRows.length
        };

        return {
            success: true,
            message: `Import complete.`,
            importedCount: newRows.length,
            duplicateCount: duplicateRows.length,
            duplicates: duplicateRows,
            undoData
        };

    } catch (error: any) {
        console.error('Failed to import to sheet:', error.message);
        const apiError = error.errors?.[0]?.message || error.message || 'An unknown error occurred during sheet import.';
        return { error: `Import Error: ${apiError}` };
    }
}


export async function undoLastAction(
    undoData: any,
    sheetUrl: string,
) {
    if (!undoData) {
        return { error: 'No undo data available.' };
    }

    const sheetIdRegex = /spreadsheets\/d\/([a-zA-Z0-T-_]+)/;
    const match = sheetUrl.match(sheetIdRegex);
    if (!match || !match[1]) {
        return { error: 'Invalid Google Sheets URL format.' };
    }
    const spreadsheetId = match[1];
    const sheetName = 'All Case';

    try {
        const sheets = getGoogleSheetsClient();

        if (undoData.operationType === 'IMPORT') {
            if (typeof undoData.sheetId !== 'number') {
                return { error: 'Invalid sheet ID for undo operation.' };
            }
            await sheets.spreadsheets.batchUpdate({
                spreadsheetId,
                requestBody: {
                    requests: [{
                        deleteDimension: {
                            range: {
                                sheetId: undoData.sheetId,
                                dimension: 'ROWS',
                                startIndex: undoData.startIndex,
                                endIndex: undoData.startIndex + undoData.count
                            }
                        }
                    }]
                }
            });
            return { success: true, message: `Successfully undone import of ${undoData.count} rows.` };
        }

        if (undoData.operationType === 'UPDATE') {
             const updateRequests = undoData.updatedRows.flatMap((row: { rowIndex: number, oldStatus: string, oldTicketOp: string }) => ([
                {
                    range: `${sheetName}!G${row.rowIndex}`,
                    values: [[row.oldStatus]],
                },
                {
                    range: `${sheetName}!T${row.rowIndex}`,
                    values: [[row.oldTicketOp]],
                }
            ]));

            if (updateRequests.length > 0) {
                 await sheets.spreadsheets.values.batchUpdate({
                    spreadsheetId,
                    requestBody: {
                        valueInputOption: 'USER_ENTERED',
                        data: updateRequests,
                    },
                });
            }
            return { success: true, message: `Successfully undone update of ${undoData.updatedRows.length} rows.` };
        }

        return { error: 'Unknown operation type for undo.' };

    } catch (error: any) {
        console.error('Failed to undo last action:', error.message);
        const apiError = error.errors?.[0]?.message || 'An unknown error occurred during undo operation.';
        return { error: apiError };
    }
}

export async function mergeFilesOnServer(fileAData: any, fileBData: any, mergeKey: string) {
    // Helper to find header case-insensitively
    const findHeader = (headers: string[] | undefined, key: string) => {
        if (!headers) return undefined;
        return headers.find(h => h.toLowerCase() === key.toLowerCase());
    };
    
    // Validate required data and headers
    if (!fileAData?.rows || !fileBData?.rows || !mergeKey) {
        return { mergedRows: [], unmatchedRowsB: fileBData?.rows || [], error: "Missing file data or merge key." };
    }

    const fileAMergeKey = findHeader(fileAData.headers, mergeKey);
    const fileBMergeKey = findHeader(fileBData.headers, mergeKey);
    const nisnHeaderA = findHeader(fileAData.headers, 'nisn');

    if (!fileAMergeKey || !fileBMergeKey) {
        return { 
            mergedRows: [], 
            unmatchedRowsB: fileBData.rows,
            error: `Merge key "${mergeKey}" not found in one or both files.`
        };
    }
     if (!nisnHeaderA) {
        return { 
            mergedRows: [], 
            unmatchedRowsB: fileBData.rows,
            error: `Required "NISN" header not found in File A.`
        };
    }

    // Create a map of File A for efficient lookups.
    // Key: lowercase mergeKey value. Value: Array of rows from File A that match the key.
    const fileAMap = new Map<string, any[]>();
    for (const rowA of fileAData.rows) {
        const key = String(rowA[fileAMergeKey] || '').toLowerCase().trim();
        const nisnValue = String(rowA[nisnHeaderA] || '').trim();
        
        // Only add to map if the key is valid and it has a NISN.
        if (key && nisnValue) { 
            if (!fileAMap.has(key)) {
                fileAMap.set(key, []);
            }
            // Add the row to the array for that key. We'll handle multiple matches later.
            fileAMap.get(key)?.push(rowA);
        }
    }

    const mergedRows: any[] = [];
    const unmatchedRowsB: any[] = [];
    
    for (const rowB of fileBData.rows) {
        const key = String(rowB[fileBMergeKey] || '').toLowerCase().trim();
        let matchFound = false;

        if (key && fileAMap.has(key)) {
            const potentialMatches = fileAMap.get(key) || [];
            // For simplicity, we take the first valid match.
            // More complex logic could be added here to handle multiple matches if needed.
            const firstValidMatch = potentialMatches.find(match => match[nisnHeaderA]);

            if (firstValidMatch) {
                // Match found and it has a NISN.
                const mergedRow = { ...firstValidMatch, ...rowB };
                mergedRows.push(mergedRow);
                matchFound = true;
            }
        }
        
        if (!matchFound) {
            // No match in File A OR the match in File A had no NISN
            unmatchedRowsB.push(rowB);
        }
    }
    
    return { mergedRows, unmatchedRowsB };
}

    