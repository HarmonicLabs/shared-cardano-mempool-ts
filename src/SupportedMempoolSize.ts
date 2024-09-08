
export const TX_HASH_SIZE = 32 as const;
/** index in the mempool of a given tx */
export const TX_INDEX_SIZE = 4 as const;

export type SupportedMempoolSize
    = 32768     // 32KB
    | 65536     // 64KB
    | 131072    // 128KB
    | 262144    // 256KB


export function isSupportedMempoolSize(value: any): value is SupportedMempoolSize
{
    return (
        value === 32768     ||
        value === 65536     ||
        value === 131072    ||
        value === 262144
    );
}

export function getMaxTxAllowed( size: SupportedMempoolSize ): number
{
    switch( size )
    {
        case 32768: return 64;
        case 65536: return 128;

        case 131072:
        case 262144: return 255;
        default: throw new Error(`Invalid SupportedMempoolSize: ${size}`);
    }
}