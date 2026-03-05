const fetch = require('node-fetch'); // you might need to install or use native fetch if node > 18
async function main() {
    const res = await fetch('http://localhost:3001/api/pipeline/stage/reviewed?product=ubuntu');
    const data = await res.json();
    console.log("Total Fetched:", data.data?.length);
    if (data.data && data.data.length > 0) {
        console.log("Example UI Mapping payload:", JSON.stringify(data.data[0], null, 2));
    }
}
main();
