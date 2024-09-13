import { workerData } from "worker_threads";
import { SharedMempool } from "../../SharedMempool";
import { randTx } from "../../__test_utils__/randTx";
import { mempoolAppendResultToJson, mempoolTxHashToString } from "../../types";

const mempool = new SharedMempool( workerData.memory );
console.log(
    "append init",
    {
        mempool_cfg: mempool.config,
    }
);

let MAX_TX_SIZE = 1024;
let MIN_TX_SIZE = 128;

const MAX_RANDOM_TX_SIZE = MAX_TX_SIZE - MIN_TX_SIZE;

function randSize()
{
    return Math.floor( Math.random() * MAX_RANDOM_TX_SIZE ) + MIN_TX_SIZE;
}

setInterval( async () => {
    const tx = randTx( randSize() );
    const result = await mempool.append( tx.hash, tx.bytes );
    console.log("append", mempoolAppendResultToJson( result ) );
}, 800 + Math.floor( Math.random() * 400 ) );