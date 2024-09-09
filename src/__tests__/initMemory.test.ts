import { PrivateMempool } from "../__test_utils__/PrivateMempool";
import { SharedMempool } from "../SharedMempool";
import { MempoolAppendStatus } from "../types/MempoolAppendResult";

describe("Mempool write and read", () => {

    const mem = new SharedArrayBuffer( 32768 );
    SharedMempool.initMemory( mem );
    const mempool = new SharedMempool( mem ) as unknown as PrivateMempool;

    test("correct size", async () => {
        expect( mempool.config.size ).toBe( mem.byteLength );
    });

    test("correct aviable size", async () => {
        expect( mempool._readAviableSpace() )
        .toBe( mempool.config.size - mempool.config.startTxsU8 );
    });

    test("correct nTxs", async () => {
        expect( await mempool.getTxCount() )
        .toBe( 0 );
    });
})