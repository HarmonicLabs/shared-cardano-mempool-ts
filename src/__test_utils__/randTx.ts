import { webcrypto } from "crypto";
import type { MempoolTx } from "../types/MempoolTx";
import type { U8Arr32 } from "../types/MempoolTxHash";

export function randTx( txSize: number = 512 ): MempoolTx
{
    txSize = Math.min( Math.max( 128, Math.round( txSize ) ), 16384 );

    const bytes = new Uint8Array( txSize );
    webcrypto.getRandomValues( bytes );

    const hash = new Uint8Array( 32 ) as U8Arr32;
    webcrypto.getRandomValues( hash );

    return { hash, bytes };
}