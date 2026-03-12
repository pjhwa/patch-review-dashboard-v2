const fs = require('fs');
const filepath = '/home/citec/patch-review-dashboard-v2/src/app/category/[categoryId]/[productId]/ClientPage.tsx';
let data = fs.readFileSync(filepath, 'utf8');
data = data.replace('fetch(\/api/pipeline/stage/preprocessed?productId=\\)', 'fetch(\/api/pipeline/stage/preprocessed?product=\\)');
data = data.replace('fetch(\/api/pipeline/stage/reviewed?productId=\\)', 'fetch(\/api/pipeline/stage/reviewed?product=\\)');

// also replace the fallback
data = data.replace('const rId = rPatch.issueId || rPatch.IssueID || rPatch[\\'Issue ID\\'] || rPatch.Issue_ID;', 'const rId = rPatch?.issueId || rPatch?.IssueID || rPatch?.\\'Issue ID\\' || rPatch?.Issue_ID;');
data = data.replace('return rId === patch.id || rId === patch.original_id || rId === patch.Name;', 'return rId === patch?.issueId || rId === patch?.id || rId === patch?.original_id || rId === patch?.Name;');
data = data.replace('const issueId = patch.issueId || patch.IssueID || patch[\\'Issue ID\\'] || patch.Issue_ID || \\\\;', 'const issueId = patch?.issueId || patch?.IssueID || patch?.\\'Issue ID\\' || patch?.Issue_ID || \\\\;');

fs.writeFileSync(filepath, data);
