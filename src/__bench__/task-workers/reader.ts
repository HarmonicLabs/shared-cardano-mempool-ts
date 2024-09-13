import { workerData } from "worker_threads";
import { SharedMempool } from "../../SharedMempool";
import { mempoolTxToJson } from "../../types";

const mempool = new SharedMempool( workerData.memory );
console.log(
    "reader init",
    {
        mempool_cfg: mempool.config,

    }
);

function getRandomElems<T>( arr: T[] ): T[]
{
    arr = arr.slice();
    
    const n = Math.floor( Math.random() * arr.length ) + 1;
    if( n >= arr.length )return arr;

    const result = new Array<T>( n );
    for( let i = 0; i < n; i++ )
    {
        result[i] = arr.splice(
            Math.floor( Math.random() * arr.length ),
            1
        )[0];
    }
    return result;
}

enum ReaderAction {
    GetTx = 0,
    GetTxId = 1,
}

Object.freeze( ReaderAction );

function randAction(): ReaderAction
{
    return Math.floor( Math.random() * 2 );
}

setInterval( async () => {
    switch( randAction() )
    {
        case ReaderAction.GetTx: {
            const hashes = await mempool.getTxHashes();
            const toRead = getRandomElems( getRandomElems( hashes ) );
            console.log( "reading", toRead.length, "txs" );
            const txs = await mempool.getTxs( toRead );
            break;
        }
        case ReaderAction.GetTxId: {
            await mempool.getTxHashesAndSizes();
            console.log("reading tx hases and sizes");
            break;
        }
        default: break;
    }
}, 1_500 + Math.floor( Math.random() * 500 ) );