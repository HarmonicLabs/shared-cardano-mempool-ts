export type U8Arr<Len extends number> = Uint8Array & { readonly length: Len };

export type U8Arr32 = U8Arr<32>;

export type MempoolTxHashBI = BigUint64Array & { length: 4 }; // 32 bytes
export type MempoolTxHash = Int32Array & { length: 8 }; // 32 bytes

export type MempoolTxHashLike = U8Arr32 | MempoolTxHash | MempoolTxHashBI

export function forceMempoolTxHash( hashLike: MempoolTxHashLike ): MempoolTxHash
{
    if( hashLike instanceof Int32Array )
    {
        return hashLike;
    }

    return new Int32Array( hashLike.buffer ) as MempoolTxHash;
}

export function eqMempoolTxHash(a: MempoolTxHash, b: MempoolTxHash): boolean
{
    return (
        a[0] === b[0] &&
        a[1] === b[1] &&
        a[2] === b[2] &&
        a[3] === b[3] &&
        a[4] === b[4] &&
        a[5] === b[5] &&
        a[6] === b[6] &&
        a[7] === b[7]
    );
}