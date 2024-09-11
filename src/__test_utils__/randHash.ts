import { webcrypto } from "crypto";
import { forceMempoolTxHash, type MempoolTxHash, type U8Arr32 } from "../types/MempoolTxHash";

export function randHash(): MempoolTxHash
{
    const hash = new Uint8Array( 32 ) as U8Arr32;
    webcrypto.getRandomValues( hash );

    return forceMempoolTxHash( hash );
}