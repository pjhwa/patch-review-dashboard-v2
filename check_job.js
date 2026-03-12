const { Queue } = require('bullmq');
const IORedis = require('ioredis');

const connection = new IORedis({ host: '127.0.0.1', port: 6379 });
const q = new Queue('patch-pipeline', { connection });

async function check() {
    const jobId = process.argv[2] || '1';
    const job = await q.getJob(jobId);
    if (!job) {
        console.log(`Job ${jobId} not found`);
        process.exit(0);
    }

    console.log('Progress:', job.progress);
    console.log('State:', await job.getState());
    console.log('FailedReason:', job.failedReason);

    const logs = await q.getJobLogs(jobId);
    console.log('Logs (last 15):', logs.logs.slice(-15).join('\n'));

    process.exit(0);
}

check().catch(console.error);
