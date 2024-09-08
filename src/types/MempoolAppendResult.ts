
export enum MempoolAppendStatus
{
    Ok = 0,
    AlreadyPresent = 1,
    InsufficientSpace = 2,
    MaxReached = 3,
}

Object.freeze( MempoolAppendStatus );

export interface MempoolAppendResult {
    status: MempoolAppendStatus;
    nTxs: number;
    aviableSpace: number;
}