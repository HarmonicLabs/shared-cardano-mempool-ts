import { U8Arr32 } from "./MempoTxHash";

export interface MempoolTx {
    hash: U8Arr32;
    bytes: Uint8Array;
}