const IORedis = require('ioredis');
const { Queue } = require('bullmq');
const connection = new IORedis({ host: '127.0.0.1', port: 6379 });
const queue = new Queue('patch-pipeline', { connection });

async function check() {
    const waiting = await queue.getWaiting(0, 5);
    const active = await queue.getActive(0, 5);
    const failed = await queue.getFailed(0, 2);
    console.log('WAITING:', waiting.map(function(j){ return j.id + ' (' + j.name + ')'; }));
    console.log('ACTIVE:', active.map(function(j){ return j.id + ' progress=' + j.progress; }));
    if (failed.length) {
        var logs = await queue.getJobLogs(failed[0].id);
        console.log('LAST FAILED:', failed[0].id, failed[0].failedReason, logs.logs.slice(-5));
    }
    process.exit(0);
}
check();
