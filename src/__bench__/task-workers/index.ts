import { Worker } from "worker_threads";
import { MempoolSize } from "../../types";
import { SharedMempool } from "../../SharedMempool";

void async function main()
{
    const memory = new SharedArrayBuffer( MempoolSize.kb32 );
    SharedMempool.initMemory( memory );
    const append1 = new Worker("./src/__bench__/task-workers/append.ts", { workerData: { memory } });
    const append2 = new Worker("./src/__bench__/task-workers/append.ts", { workerData: { memory } });
    const reader1 = new Worker("./src/__bench__/task-workers/reader.ts", { workerData: { memory } });
    const reader2 = new Worker("./src/__bench__/task-workers/reader.ts", { workerData: { memory } });
    const dropper = new Worker("./src/__bench__/task-workers/dropper.ts", { workerData: { memory } });

    dropper.on("error", (err) => { throw err; });

    const mempool = new SharedMempool( memory );

}();