import { NextResponse } from 'next/server';
import fs from 'fs';
import path from 'path';
import Papa from 'papaparse';

export async function GET(request: Request, props: { params: Promise<{ id: string }> }) {
    try {
        const { id } = await props.params;
        const { searchParams } = new URL(request.url);
        const productId = searchParams.get('productId');

        // Path should match the directory structure of the linuxSkillDir
        const linuxSkillDir = path.join(process.env.HOME || '/home/citec', '.openclaw/workspace/skills/patch-review/os/linux-v2');
        const archiveFilePath = path.join(linuxSkillDir, 'archive', id, 'patch_review_ai_report.json');

        // Check if file exists
        if (!fs.existsSync(archiveFilePath)) {
            return new NextResponse('File not found', { status: 404 });
        }

        const fileContent = fs.readFileSync(archiveFilePath, 'utf-8');
        let parsedData: any[] = [];
        try {
            parsedData = JSON.parse(fileContent);
        } catch (e) {
            return new NextResponse('Invalid JSON format in archive', { status: 500 });
        }

        if (!productId) {
            // Return raw CSV if no product filter is provided
            const fullCsv = Papa.unparse(parsedData);
            const response = new NextResponse(fullCsv);
            response.headers.set('Content-Type', 'text/csv');
            response.headers.set('Content-Disposition', `attachment; filename="archive_${id}_patches.csv"`);
            return response;
        }

        // Filter based on product
        const targetVendorMapping: { [key: string]: string } = {
            'redhat': 'Red Hat',
            'oracle': 'Oracle',
            'ubuntu': 'Ubuntu'
        };
        const targetVendor = targetVendorMapping[productId];

        if (!targetVendor) {
            return new NextResponse('Invalid product ID for filtering', { status: 400 });
        }

        let filteredData: any[] = [];
        if (Array.isArray(parsedData)) {
            filteredData = parsedData.filter((row: any) => {
                const vendor = row.Vendor || row.vendor;
                return vendor && String(vendor).toLowerCase().includes(targetVendor.toLowerCase());
            });
        }

        // If no matches are found, output an empty CSV with headers
        const exportData = filteredData.length > 0 ? filteredData : [];
        const filteredCsv = Papa.unparse(exportData, {
            columns: ['IssueID', 'Component', 'Version', 'Vendor', 'Date', 'Criticality', 'Description', 'KoreanDescription']
        });

        const response = new NextResponse(filteredCsv);
        response.headers.set('Content-Type', 'text/csv');
        response.headers.set('Content-Disposition', `attachment; filename="archive_${productId}_${id}_patches.csv"`);
        return response;

    } catch (error) {
        console.error("Archive download failed:", error);
        return new NextResponse('Internal Server Error', { status: 500 });
    }
}
