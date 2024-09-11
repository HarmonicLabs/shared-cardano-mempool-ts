import { IndexedHash, MempoolIndex, MempoolTxHash } from "../types";

export interface TxGroup {
    // txs: MempoolTxHash[];
    firstIdx: number;
    txs: number;
    start: number;
    size: number;
}

export function groupConsecutiveTxs(
    indexedHashes: IndexedHash[],
    indexes: MempoolIndex[]
): TxGroup[]
{
    const result: TxGroup[] = [];
    if( indexedHashes.length === 0 ) return result;
    if( indexedHashes.length !== indexes.length ) throw new Error("indexedHashes and indexes must have the same length");

    const [ fst, ...rest ] = indexedHashes;
    const [ fstIndex, ...restIdx ] = indexes;

    let lastIdx = fst[1];
    let currentGroup: TxGroup = {
        // txs: [ fst[0] ],
        firstIdx: lastIdx,
        txs: 1,
        start: fstIndex.start,
        size: fstIndex.size
    };
    for(
        let i = 0,
        elem = rest[i],
        idx = restIdx[i];
        
        i < rest.length;

        i++,
        elem = rest[i],
        idx = restIdx[i]
    )
    {
        const elemIdx = elem[1];
        if( elemIdx !== lastIdx + 1 )
        {
            // currentGroup cannot be empty
            result.push( currentGroup );
            currentGroup = {
                // txs: [],
                firstIdx: elemIdx,
                txs: 0,
                start: idx.start,
                size: 0
            };
        }
        // currentGroup.txs.push(elem[0]);
        currentGroup.txs++;
        currentGroup.size += idx.size;
        lastIdx = elemIdx;
    }
    // currentGroup cannot be empty
    result.push( currentGroup );

    return result;
}