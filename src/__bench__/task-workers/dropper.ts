import { workerData } from "worker_threads";
import { SharedMempool } from "../../SharedMempool";
import { groupConsecutiveTxs } from "../../utils/groupConsecutiveTxs";

const mempool = new SharedMempool( workerData.memory );
console.log(
    "dropper init",
    {
        mempool_cfg: mempool.config
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

setInterval( async () => {
    const hashes = await mempool.getTxHashesAndSizes();

    const toDrop = getRandomElems( hashes );

    console.log("dropping", toDrop.length, "txs");

    await mempool.drop( toDrop.map(({ hash }) => hash) );

    console.log(
        "dropped",
        toDrop.length,
        "txs"
    );
}, 10_000 );