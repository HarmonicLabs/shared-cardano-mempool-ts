import { U8Arr32 } from "./MempoolTxHash";

export interface MempoolTx {
    hash: U8Arr32;
    bytes: Uint8Array;
}