const IORedis = require('ioredis');
const { Queue } = require('bullmq');
const connection = new IORedis({ host: '127.0.0.1', port: 6379 });
const queue = new Queue('patch-pipeline', { connection });

async function check() {
    const failed = await queue.getFailed(0, 5);
    for (const job of failed) {
        console.log('Failed job ID:', job.id);
        console.log('Reason:', job.failedReason);
        console.log('Data:', JSON.stringify(job.data));
    }
    process.exit(0);
}
check();
