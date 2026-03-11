import { NextResponse } from 'next/server';
import fs from 'fs';
import path from 'path';

export async function GET(request: Request) {
    try {
        const { searchParams } = new URL(request.url);
        const q = searchParams.get('q');

        if (!q || q.trim().length === 0) {
            return NextResponse.json({ success: true, results: [] });
        }

        const query = q.trim().toLowerCase();
        const linuxSkillDir = path.join(process.env.HOME || '/home/citec', '.openclaw/workspace/skills/patch-review/os/linux-v2');
        
        const dataDirs = ['redhat/redhat_data', 'oracle/oracle_data', 'ubuntu/ubuntu_data'];
        const results = [];
        
        for (const relativeDir of dataDirs) {
            const absoluteDir = path.join(linuxSkillDir, relativeDir);
            if (!fs.existsSync(absoluteDir)) continue;

            const dirFiles = fs.readdirSync(absoluteDir);
            const files = dirFiles.filter(f => f.endsWith('.json')).map(f => path.join(absoluteDir, f));
            
            for (const file of files) {
                try {
                    const content = fs.readFileSync(file, 'utf8');
                    // Fast check before parsing JSON
                    if (!content.toLowerCase().includes(query)) continue;
                    
                    const item = JSON.parse(content);
                    
                    // Simple search across fields
                    const searchableText = `${item.id || ''} ${item.title || ''} ${item.description || ''} ${item.component || ''}`.toLowerCase();
                    
                    if (searchableText.includes(query)) {
                        // Re-format to look somewhat like the preprocessed patches schema
                        results.push({
                            id: item.id || item.issueId || path.basename(file, '.json'),
                            vendor: item.vendor || 'Unknown',
                            component: item.component || item.packages?.[0] || 'Unknown',
                            title: item.title || '',
                            date: item.pubDate || item.dateStr || item.issued || '',
                            summary: item.synopsis || item.overview || item.description || '',
                            ref_url: item.url || '',
                            severity: item.severity || '',
                            _sourceFile: file // Keep track just in case
                        });
                        
                        // Limit to top 50 matches to avoid overwhelming payload
                        if (results.length >= 50) {
                            return NextResponse.json({ success: true, results });
                        }
                    }
                } catch (e) {
                    // Ignore parsing errors for single files
                }
            }
        }
        
        return NextResponse.json({ success: true, results });
    } catch (error: any) {
        console.error("Search failed:", error);
        return NextResponse.json({ error: error.message || 'Search failed' }, { status: 500 });
    }
}
