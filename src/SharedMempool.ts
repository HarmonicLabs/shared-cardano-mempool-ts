import { getMaxTxAllowed, isSupportedMempoolSize, SupportedMempoolSize } from "./types/SupportedMempoolSize";
import { IndexedHash, insertSortedHash } from "./types/IndexedHash";
import { MempoolAppendResult, MempoolAppendStatus } from "./types/MempoolAppendResult";
import { MempoolIndex } from "./types/MempoolIndex";
import { MempoolTx } from "./types/MempoolTx";
import { eqMempoolTxHash, forceMempoolTxHash, isMempoolTxHash, isMempoolTxHashLike, MempoolTxHash, MempoolTxHashBI, MempoolTxHashLike, U8Arr32 } from "./types/MempoolTxHash";
import { concatArrayBuffs, concatUint8Arr } from "./utils/concatUint8Arr";
import { unwrapWaitAsyncResult } from "./utils/unwrapWaitAsyncResult";
import { groupConsecutiveTxs } from "./utils/groupConsecutiveTxs";


export interface SharedMempoolArgs {
    
}

export const defaultConfig: SharedMempoolArgs = {

};

export interface SharedMempoolConfig extends SharedMempoolArgs
{
    readonly size: SupportedMempoolSize,
    readonly maxTxs: number,
    readonly allHashesSize: number
    readonly startHashesU8: number,
    readonly startTxsU8: number,
}

export interface TxHashAndSize{
    hash: MempoolTxHash;
    size: number;
}

export interface IMempool {
    readonly config: SharedMempoolConfig;
    getTxCount(): Promise<number>;
    getAviableSpace(): Promise<number>;
    getTxHashes(): Promise<MempoolTxHash[]>;
    getTxHashesAndSizes(): Promise<TxHashAndSize[]>;
    getTxs( hashes: MempoolTxHashLike[] ): Promise<MempoolTx[]>;
    append( hash: MempoolTxHashLike, tx: Uint8Array ): Promise<MempoolAppendResult>;
    drop( hashes: MempoolTxHashLike[] ): Promise<void>;
}

export const PERFORMING_DROP = 0;
export const NOT_PERFORMING_DROP = 1;

export const N_MUTEX_BYTES = 16;
export const N_MUTEX_U8 = N_MUTEX_BYTES;
export const N_MUTEX_I32 = Math.ceil( N_MUTEX_BYTES / 4 ) as 4;
export const N_MUTEX_BI64 = Math.ceil( N_MUTEX_BYTES / 8 ) as 2;

function toIndexesOffset( i: number ): number
{
    return N_MUTEX_I32 + i - 1;
}

export const TX_COUNT_U8_OFFSET = 12;

export const PERFORMING_DROP_I32_IDX = 0;
export const READING_PEERS_I32_IDX = 1;
export const APPEND_QUEQUE_I32_IDX = 2;
export const APPEND_INFO_BYTES_I32_IDX = 3;

export const APPEND_INFO_BYTES_U8_IDX = APPEND_INFO_BYTES_I32_IDX * 4;
export const AVIABLE_SPACE_U8_IDX = APPEND_INFO_BYTES_U8_IDX + 1;

export const SINGLE_INDEX_SIZE = 4;
export const TX_HASH_SIZE = 32;

/**
```ts
[
    PERFORMING_DROP_mutex,                              // 4 bytes ( only i32 allows `Atomics.notify` and `Atomics.waitAsync` )
    reading_peers_count,                                // 4 bytes ( `Atomics.notify` and `Atomics.waitAsync` on 0 )
    append_queque,                                      // 4 bytes ( `Atomics.notify` and `Atomics.waitAsync` one at the time )
    // tx_count ( 1 byte ) | aviable_space ( 3 bytes )  // 4 bytes, also `APPEND_INFO_BYTES`
    tx_count | aviable_space,     

    // end of mutex bytes (N_MUTEX_BYTES)

    // length inferred by reading the following index
    // last index length is inferred by `(size - startIndex) - aviableSpace`
    // the first tx index is always `startTxsU8` so we don't store it
    ...indexes,         // 4 bytes each, 4 * (maxTxs - 1) total
    ...hashes,          // 32 bytes each, 32 * maxTxs total
    ...txs,             // variable size, up to `size - startTxsU8`
]
```
*/

export class SharedMempool implements IMempool
{
    private readonly sharedMemory: SharedArrayBuffer;
    private readonly bi64View: BigUint64Array;
    private readonly int32View: Int32Array;
    private readonly u32View: Uint32Array;
    // private readonly indexes: Uint32Array;
    // private readonly hashes: Uint32Array;
    private readonly u8View: Uint8Array;
    readonly config: SharedMempoolConfig;

    static initMemory( size: SupportedMempoolSize ): SharedArrayBuffer
    static initMemory( buff: SharedArrayBuffer ): SharedArrayBuffer
    static initMemory( buff: SupportedMempoolSize | SharedArrayBuffer ): SharedArrayBuffer
    {
        const size = typeof buff === "number" ? buff : buff?.byteLength;
        buff = buff instanceof SharedArrayBuffer ? buff : new SharedArrayBuffer( size );
        if( !isSupportedMempoolSize( size ) ) throw new Error(`Invalid SharedMempool size: ${size}`);

        const view = new Uint32Array( buff );
        view.fill( 0 );

        Atomics.store( view, 0, 0 );
        Atomics.store( view, 1, 0 );
        Atomics.store( view, 2, 0 );
        Atomics.store( view, 3, 0 );

        const mempool = new SharedMempool( buff );
        Atomics.store(
            mempool.int32View,
            0,
            NOT_PERFORMING_DROP
        );
        mempool._writeAviableSpace(
            size - mempool.config.startTxsU8
        );

        return new SharedArrayBuffer( size );
    }

    constructor(
        sharedMemory: SharedArrayBuffer,
        config: SharedMempoolArgs = defaultConfig
    )
    {
        if (!(typeof globalThis.SharedArrayBuffer !== "undefined")) throw new Error("SharedArrayBuffer not supported, cannot create SharedMempool");

        const size = sharedMemory.byteLength;
        if( !isSupportedMempoolSize( size ) ) throw new Error(`Invalid SharedMempool size: ${size}`);

        const maxTxs = getMaxTxAllowed( size );

        // const startIndexes = N_MUTEX_BYTES;
        const startHashesU8 = N_MUTEX_BYTES + ( maxTxs * SINGLE_INDEX_SIZE );
        const startTxsU8 = startHashesU8 + ( maxTxs * TX_HASH_SIZE );

        /*
        ...indexes,         // 4 bytes each, 4 * (maxTxs - 1) total
        ...hashes,          // 32 bytes each, 32 * maxTxs total
        ...txs,             // variable size, up to `size - startTxsU8`
        */

        this.sharedMemory = sharedMemory;
        this.bi64View = new BigUint64Array( sharedMemory );
        this.int32View = new Int32Array( sharedMemory );
        this.u32View = new Uint32Array( sharedMemory );
        // this.indexes = new Uint32Array( sharedMemory, N_MUTEX_BYTES, maxTxs - 1 );
        // this.hashes = new Uint32Array( sharedMemory, startHashesU8, maxTxs * (TX_HASH_SIZE / 4) );
        this.u8View = new Uint8Array( sharedMemory );

        this.config = Object.freeze({
            ...defaultConfig,
            ...config,
            size,
            maxTxs,
            allHashesSize: maxTxs * TX_HASH_SIZE,
            startHashesU8,
            startTxsU8
        });
    }

    private _unsafe_write( offset: number, data: Uint8Array ): void
    {
        // UNSAFE WRITE
        this.u8View.set( data, offset );
    }
    private _unsafe_read( offset: number, length: number ): ArrayBuffer
    {
        const buff = new ArrayBuffer( length );
        const u8 = new Uint8Array( buff );
        u8.set( this.u8View.subarray( offset, offset + length ));
        return buff;
    }
    private _read( offset: number, length: number ): Uint8Array
    {
        const roudnedLength = Math.ceil( length / 8 ) * 8;
        const buff = new ArrayBuffer( roudnedLength );
        const bi64 = new BigUint64Array( buff );

        for( let i = 0; i < bi64.length; i++ )
        {
            bi64[i] = Atomics.load( this.bi64View, offset );
            offset += 8;
        }

        return new Uint8Array( buff, 0, length );
    }

    async getTxCount(): Promise<number>
    {
        await this._makeSureNoDrop();
        this._incrementReadingPeers();
        const n = this._getTxCount();
        this._decrementReadingPeers();
        return n;
    }

    async getAviableSpace(): Promise<number>
    {
        await this._makeSureNoDrop();
        this._incrementReadingPeers();
        const n = this._readAviableSpace();
        this._decrementReadingPeers();
        return n;
    }

    async getTxHashes(): Promise<MempoolTxHash[]>
    {
        await this._makeSureNoDrop();
        this._incrementReadingPeers();

        const nTxs = this._getTxCount();
        const hashBuff = this._unsafe_readTxHashesBuff( nTxs );

        this._decrementReadingPeers();

        return this._hashBuffToHashes( hashBuff, nTxs );
    }

    async getTxHashesAndSizes(): Promise<TxHashAndSize[]>
    {
        await this._makeSureNoDrop();
        this._incrementReadingPeers();

        const nTxs = this._getTxCount();
        if( nTxs <= 0 )
        {
            this._decrementReadingPeers();
            return [];
        }

        const hashBuff = this._unsafe_readTxHashesBuff( nTxs );
        const idxBuff = this._unsafe_readTxIndexesBuff( nTxs );

        this._decrementReadingPeers();

        const hashes = this._hashBuffToHashes( hashBuff, nTxs );
        const indexes = this._idxBuffToIndexes( idxBuff, nTxs );

        const result = new Array<TxHashAndSize>( nTxs );
        for( let i = 0; i < nTxs; i++ )
        {
            result[i] = {
                hash: hashes[i],
                size: indexes[i].size
            };
        }

        return result;
    }

    private _hashBuffToHashes( buff: ArrayBuffer, nTxs: number ): MempoolTxHash[]
    {
        const hashes = new Array<MempoolTxHash>( nTxs );
        const i32Buff = new Int32Array( buff );
        let tmp: Int32Array;
        for( let i = 0; i < nTxs; )
        {
            tmp = new Int32Array( 8 );
            tmp.set( i32Buff.subarray( i * 8, (i + 1) * 8 ) );
            hashes[i++] = tmp as MempoolTxHash;
        }
        return hashes;
    }

    private _idxBuffToIndexes( buff: Uint32Array, nTxs: number ): MempoolIndex[]
    {
        if( nTxs <= 0 ) return [];
        nTxs = Math.min( nTxs, this.config.maxTxs ); // at most maxTxs

        const indexes = new Array<MempoolIndex>( nTxs );
        indexes[0] = {
            start: this.config.startTxsU8,
            size: buff[0] - this.config.startTxsU8
        };
        for( let i = 1; i < nTxs; i++ )
        {
            indexes[i] = {
                start: buff[i - 1],
                size: buff[i] - buff[i - 1]
            };
        }
        if( nTxs >= this.config.maxTxs )
        {
            const lastStart = buff[nTxs - 2];
            indexes[nTxs - 1] = {
                start: lastStart,
                size: (this.config.size - lastStart) - this._readAviableSpace()
            };
        }
        return indexes;
    }

    async getTxs( hashes: MempoolTxHashLike[] ): Promise<MempoolTx[]>
    {
        if( hashes.length === 0 ) return [];

        { // waitPromise scope
            const waitPromise = this._makeSureNoDrop();
            hashes = hashes.map( forceMempoolTxHash );
            await waitPromise;
        }

        this._incrementReadingPeers();

        const _txs = this._readTxs( hashes as MempoolTxHash[] );

        this._decrementReadingPeers();

        if( _txs.length === 0 ) return [];
        const [ buffs, indexes, indexedHashes ] = _txs;

        const buff = concatArrayBuffs( buffs );
        let offset = 0;
        const txs = new Array<MempoolTx>( indexes.length );
        let hashView: Uint8Array; 
        for( let i = 0; i < indexes.length; i++ )
        {
            const { size } = indexes[i];
            const hash = new Uint8Array( 32 ) as U8Arr32
            const hashView = new Int32Array( hash.buffer );
            hashView.set( indexedHashes[i][0] );
            txs[i] = {
                hash,
                bytes: new Uint8Array( buff.buffer, offset, size )
            };
            offset += size;
        }

        return txs;
    }

    async append( hash: MempoolTxHashLike, tx: Uint8Array ): Promise<MempoolAppendResult>
    {
        hash = forceMempoolTxHash( hash );
        if( !isMempoolTxHash( hash ) ) throw new Error("Invalid hash");

        await this._initAppend();

        const [ nTxs, aviableSpace ] = this._getAppendInfos();
        if(
            nTxs >= this.config.maxTxs
            || aviableSpace < tx.byteLength
        )
        {
            this._deinitAppend();
            if( aviableSpace < tx.byteLength )
            return {
                status: MempoolAppendStatus.InsufficientSpace,
                nTxs,
                aviableSpace
            };
            else return {
                status: MempoolAppendStatus.MaxTxsReached,
                nTxs,
                aviableSpace
            };
        }

        if( this._isHashPresent( hash as MempoolTxHash, nTxs ) )
        {
            this._deinitAppend();
            return {
                status: MempoolAppendStatus.AlreadyPresent,
                nTxs,
                aviableSpace
            };
        }

        // actually write the tx and hash
        const lastTxIndex = (
            nTxs <= 0 ? 
            { start: this.config.startTxsU8, size: 0 } as MempoolIndex :
            this._readTxIndexAt( nTxs - 1 )
        );
        const thisTxIndexStart = lastTxIndex.start  + lastTxIndex.size;

        this._writeTxHashAt( nTxs, hash as MempoolTxHash );
        // UNSAFE WRITE
        // writes without lock (no `Atomics`)
        // this should be fine since only one append is allowed at a time
        this._unsafe_write( thisTxIndexStart, tx );
        this._writeTxIndexAt(
            nTxs,
            { start: thisTxIndexStart, size: tx.byteLength }
        );

        // finalize tx write
        this._incrementTxCount();
        this._decrementAviableSpace( tx.byteLength );

        this._deinitAppend();
        return {
            status: MempoolAppendStatus.Ok,
            nTxs: nTxs + 1,
            aviableSpace: aviableSpace - tx.byteLength
        };
    }

    async drop( hashes: MempoolTxHashLike[] ): Promise<void>
    {
        { // initPromise scope
            const initPromise = this._initDrop();
            hashes = hashes.filter( isMempoolTxHashLike ).map( forceMempoolTxHash );
            await initPromise;
        }

        const [ nTxs, aviableSpace ] = this._getAppendInfos();

        if( nTxs <= 0 ) // nothing to drop
        {
            this._deinitDrop();
            return;
        }
        
        const indexedHashes = this._unsafe_filterByHashPresent( hashes as MempoolTxHash[], nTxs );
        if( indexedHashes.length <= 0 ) // nothing to drop
        {
            this._deinitDrop();
            return;
        }
        if( indexedHashes.length === nTxs ) // drop all
        {
            const view = new Uint32Array(
                this.sharedMemory,
                N_MUTEX_U8,
                (this.config.size - N_MUTEX_U8) / 4
            );
            view.fill( 0 );

            this._writeAviableSpace(
                this.config.size - this.config.startTxsU8
            );
            this._writeTxCount( 0 );
            this._deinitDrop();
            return;
        }
        
        const nTxsToDrop = indexedHashes.length;
        const memIndexesToDrop = indexedHashes.map( ([ _hash, idx ]) => this._readTxIndexAt( idx ));

        // if all the txs to remove are at the end
        if( indexedHashes[0][1] === nTxs - nTxsToDrop )
        {
            const freeSpace = memIndexesToDrop.reduce( (acc, { size }) => acc + size, 0 );
            // this is all we need to do
            // since all transactions remaining are already alligned to the start
            this._subTxCount( nTxsToDrop );
            this._writeAviableSpace( aviableSpace - freeSpace )
            this._deinitDrop();
            return;
        }

        const groups = groupConsecutiveTxs( indexedHashes, memIndexesToDrop );

        let currAviableSpace = aviableSpace;
        let currNTxs = nTxs;

        // from last to first
        // to make sure we don't overwrite useful stuff
        for(
            let i = groups.length - 1;
            i >= 0;
            i--
        )
        {
            const { firstIdx, txs, start, size } = groups[i];
            const from = firstIdx + txs;
            const to = firstIdx;

            const moved = this._readAllIndexes().slice( from );

            this._writeConsecutiveMemIndexes(
                to,
                moved,
                -size
            );

            this._moveHashes(
                from,
                to,
                currNTxs - from // number of txs after the removed ones
            );
            this._moveTxs(
                start + size,   // from the end of the one to drop
                start,          // to the start (to overwrite)
                // size of the bytes to move
                this.config.size // entire memory size
                - this.config.startTxsU8 // space allocated for all txs
                - start - size // all space after the dropped txs 
                - currAviableSpace // space actually used by txs
            );
            currNTxs -= txs;
            currAviableSpace += size;
        }

        this._writeTxCount( currNTxs );
        this._writeAviableSpace( currAviableSpace );
        this._deinitDrop();
    }

    private _readAllIndexes(): MempoolIndex[]
    {
        const nTxs = this._getTxCount();
        if( nTxs <= 0 ) return [];

        const idxBuff = this._unsafe_readTxIndexesBuff( nTxs );

        return this._idxBuffToIndexes( idxBuff, nTxs );
    }

    private _unsafe_move( from: number, to: number, size: number ): void
    {
        // if( from === to ) return;
        this._unsafe_write(
            to,
            new Uint8Array( this._unsafe_read( from, size ) )
        );
    }

    private _moveHashes( from: number, to: number, nTxs: number ): void
    {
        this._unsafe_move(
            this.config.startHashesU8 + (from * TX_HASH_SIZE),
            this.config.startHashesU8 + (to * TX_HASH_SIZE),
            nTxs * TX_HASH_SIZE
        );
    }

    private _moveTxs( from: number, to: number, totSize: number ): void
    {
        this._unsafe_move(
            this.config.startTxsU8 + from,
            this.config.startTxsU8 + to,
            totSize
        );
    }

    private _readTxs( hashes: MempoolTxHash[] ): [ buffs: ArrayBuffer[], indexes: MempoolIndex[], indexedHashes: IndexedHash[] ] | []
    {
        const [ nTxs, aviableSpace ] = this._getAppendInfos();
        if( nTxs <= 0 ) return [];
        
        const indexedHashes = this._unsafe_filterByHashPresent( hashes, nTxs );
        if( indexedHashes.length === 0 ) return [];

        const indexes = indexedHashes.map( ([ _hash, idx ]) => this._readTxIndexAt( idx ));

        const continousReads: MempoolIndex[] = [ { ...indexes[0] } ];
        let lastTxIndex: number = indexes[0].start ;
        const len = indexes.length;
        for( let i = 1; i < len; i++ )
        {
            const index = indexes[i];
            if( index.start  === lastTxIndex + 1 )
            {
                continousReads[continousReads.length - 1].size += index.size;
            }
            else
            {
                continousReads.push({ ...index  });
            }
            lastTxIndex = index.start ;
        }

        const buffs = continousReads.map( ({ start, size }) => this._unsafe_read( start, size ));
        
        return [ buffs, indexes, indexedHashes ];
    }

    /**
     * 
     * @returns {IndexedHash[]}
     * the hashes that are actually present in the mempool
     * paired with their index in the ordered txs
     * 
     * the elements are sorted by index
     */
    private _unsafe_filterByHashPresent( hashes: MempoolTxHash[], nTxs: number ): IndexedHash[]
    {
        if( hashes.length === 0 ) return [];

        nTxs = nTxs ?? this._getTxCount();
        if( nTxs <= 0 ) return [];

        const filtered: ([ hash: MempoolTxHash, idx: number ])[] = [];
        let len = 0;

        const buff = this._unsafe_readTxHashesBuff( nTxs );

        const realHashes = new Array<MempoolTxHash>( nTxs );
        for( let i = 0; i < nTxs; i++ )
        {
            realHashes[i] = new Int32Array(
                buff,
                (i * 32),
                8
            ) as MempoolTxHash;
        }

        for( let i = 0; i < nTxs; i++ )
        {
            const realHash = realHashes[i];
            if( hashes.some( hash => eqMempoolTxHash( hash, realHash ) ) )
            {
                // IMPORTANT
                // always sort by index
                insertSortedHash( filtered, [ realHash, i ] );
                if( // found all
                    ++len === hashes.length
                ) break;
            }
        }
        return filtered;
    }
    private _filterByHashPresent( hashes: MempoolTxHash[], nTxs?: number ): IndexedHash[]
    {
        if( hashes.length === 0 ) return [];

        nTxs = nTxs ?? this._getTxCount();
        const filtered: ([ hash: MempoolTxHash, idx: number ])[] = [];
        let len = 0;
        for( let i = 0; i < nTxs; i++ )
        {
            const realHash = new Int32Array(
                this._readTxHashAt( i ).buffer
            ) as MempoolTxHash;
            if( hashes.some( hash => eqMempoolTxHash( hash, realHash ) ) )
            {
                insertSortedHash( filtered, [ realHash, i ] );
                if(
                    ++len === hashes.length
                ) break;
            }
        }
        return filtered;
    }

    /**
     * IN ORDER
     * 
     * - check no drop is happening
     * - check no reading peers
     * - increment reading peers
     */
    private async _initDrop(): Promise<void>
    {
        await this._makeSureNoDrop();

        // stores `PERFORMING_DROP` **ONLY IF** `NOT_PERFORMING_DROP` was there
        // if instead `PERFORMING_DROP` was already there, it returns `PERFORMING_DROP`
        const oldState = Atomics.compareExchange(
            this.int32View,
            0,
            NOT_PERFORMING_DROP, // expected value
            PERFORMING_DROP // value to store (if expected value is there)
        );
        if( oldState !== NOT_PERFORMING_DROP ) return this._initDrop();

        await this._makeSureNoReadingPeers();

        this._incrementReadingPeers();
    }

    /**
     * IN ORDER
     * 
     * - store `NOT_PERFORMING_DROP`
     * - notify drop is done (will also notify potential other droppers)
     * - decrement reading peers (notify if 0, very likely, will also notify potential other droppers)
     */
    private _deinitDrop(): void
    {
        Atomics.store( this.int32View, 0, NOT_PERFORMING_DROP );
        Atomics.notify( this.int32View, 0 );
        this._decrementReadingPeers();
    }

    /**
     * UNSAFE
     * ONLY CALL AFTER AWAITING `_makeSureNoDrop`
     */
    private _incrementReadingPeers(): void
    {
        Atomics.add( this.int32View, READING_PEERS_I32_IDX, 1 );
    }

    private _decrementReadingPeers(): void
    {
        const prev = Atomics.sub( this.int32View, READING_PEERS_I32_IDX, 1 );
        if( prev <= 1 )
        {
            Atomics.notify( this.int32View, READING_PEERS_I32_IDX );
        }
    }

    private _incrementTxCount(): void
    {
        Atomics.add( this.u8View, TX_COUNT_U8_OFFSET, 1 );
    }
    private _subTxCount( n: number ): void
    {
        Atomics.sub( this.u8View, TX_COUNT_U8_OFFSET, n );
    }
    private _writeTxCount( n: number ): void
    {
        Atomics.store( this.u8View, TX_COUNT_U8_OFFSET, n );
    }

    private _makeSureNoDrop(): void | Promise<void>
    {
        // not-equal there was no drop;
        // timed-out means it took too long;
        // ok means there was a drop and it ended;
        const { async, value } = Atomics.waitAsync(
            this.int32View,
            0,
            PERFORMING_DROP,
            3000 // 3 seconds timeout
            // (`drop` might wait 1 seconds for reading peers to finish)
        );
        if( async ) return value as unknown as Promise<void>;
        return;
    }

    private async _makeSureNoReadingPeers(): Promise<void>
    {
        let currentReadingPeers = this._getReadingPeers();
        let value: "ok" | "not-equal" | "timed-out" = "not-equal";
        while( currentReadingPeers !== 0 )
        {
            value = await unwrapWaitAsyncResult(
                Atomics.waitAsync(
                    this.int32View,
                    READING_PEERS_I32_IDX,
                    currentReadingPeers,
                    1000 // 1 second timeout
                )
            );

            switch( value )
            {
                // only edge case we care about
                // not-equal means we need to recheck the reading peers count
                // since it changed since we read and it might be 0 now
                case "not-equal":
                    currentReadingPeers = this._getReadingPeers();
                    break;
                // ok means noone is reading
                case "ok":
                // timed-out means it took too long
                // and we proceed anyway
                case "timed-out":
                default:
                    return;
            }
        }
    }

    private _getReadingPeers(): number
    {
        return Atomics.load( this.int32View, READING_PEERS_I32_IDX );
    }

    private _readTxIndexAt( i: number ): MempoolIndex
    {
        if( i < 0 ) return { start: this.config.startTxsU8, size: 0 }

        if( i === 0 ) return {
            start: this.config.startTxsU8,
            size: Atomics.load( this.u32View, N_MUTEX_I32 ) - this.config.startTxsU8
        };

        if( i >= this.config.maxTxs - 1 )
        {
            const offset = N_MUTEX_I32 + (this.config.maxTxs - 2);
            const start = Atomics.load( this.u32View, offset );

            return {
                start,
                size: this.config.size - start - this._readAviableSpace()
            };
        }

        const nextOffset = N_MUTEX_I32 + i;
 
        const start = Atomics.load( this.u32View, nextOffset - 1 );
        const nextStart = Atomics.load( this.u32View, nextOffset );

        return {
            start,
            size: nextStart - start
        };
    }

    private _writeTxIndexAt( i: number, index: MempoolIndex ): void
    {
        if( i <= 0 )
        {
            Atomics.store( this.u32View, N_MUTEX_I32, this.config.startTxsU8 + index.size );
            return;
        }
        if( i >= this.config.maxTxs - 1 )
        {
            const offset = toIndexesOffset( this.config.maxTxs - 1 );
            Atomics.store( this.u32View, offset, index.start );
            return;
        }

        const offset = toIndexesOffset( i );

        // this tx start
        Atomics.store( this.u32View, offset, index.start );
        // next tx start
        Atomics.store( this.u32View, offset + 1, index.start + index.size );
    }

    private _writeConsecutiveMemIndexes(
        to: number,
        indexes: MempoolIndex[],
        toAdd: number = 0
    ): void
    {
        const max = to + indexes.length;
        for( let i = to, j = 0 ; i < max; i++, j++ ) 
        {
            indexes[j].start += toAdd;
            this._writeTxIndexAt( i, indexes[j] );
        }
        /*
        if( indexes.length < 1 ) return;
        if( indexes.length === 1 )
        {
            const idx = indexes[0];
            idx.start += toAdd;
            this._writeTxIndexAt( to, idx );
            return;
        }
        // index at 0 start is always implicit
        if(
            to === 0 ||
            indexes[0].start === this.config.startTxsU8
        )
        {
            to++;
            indexes.shift();
            if( indexes.length === 1 )
            {
                const idx = indexes[0];
                idx.start += toAdd;
                this._writeTxIndexAt( to, idx );
                return;
            }
        }

        let to = to + indexes.length - 1;
        if( to >= this.config.maxTxs - 1 )
        {
            const idx = indexes.pop()!;
            idx.start += toAdd;
            this._writeTxIndexAt( this.config.maxTxs - 1, idx );

            indexes = indexes.slice( 0, this.config.maxTxs - 2 - to );
            to = to + indexes.length - 1;
        }
        
        let offset = toIndexesOffset( to );
        const upToSecondLast = toIndexesOffset( to + indexes.length - 2 );
        for( ; offset < upToSecondLast; offset++ )
        {
            const index = indexes.shift()!;
            Atomics.store( this.u32View, offset, index.start + toAdd );
        }
        const last = indexes.pop()!;
        last.start += toAdd;
        this._writeTxIndexAt( to + indexes.length - 1, last );
        //*/
    }

    private _getTxCount(): number
    {
        return Math.max(
            Math.min(
                Atomics.load( this.u8View, TX_COUNT_U8_OFFSET ),
                this.config.maxTxs
            ),
            0
        );
    }

    private _readTxHashAt( i: number ): MempoolTxHash
    {
        const buff = new ArrayBuffer( 32 );
        const hash = new Int32Array( buff ) as MempoolTxHash;

        let offset = (this.config.startHashesU8 / 4) + ( i * 8 );

        const read = this._unsafe_read( offset, 32 );

        hash[0] = Atomics.load( this.int32View, offset );
        hash[1] = Atomics.load( this.int32View, ++offset );
        hash[2] = Atomics.load( this.int32View, ++offset );
        hash[3] = Atomics.load( this.int32View, ++offset );
        hash[4] = Atomics.load( this.int32View, ++offset );
        hash[5] = Atomics.load( this.int32View, ++offset );
        hash[6] = Atomics.load( this.int32View, ++offset );
        hash[7] = Atomics.load( this.int32View, ++offset );

        return hash;
    }

    private _writeTxHashAt( i: number, hash: MempoolTxHash ): void
    {
        this._unsafe_write(
            this.config.startHashesU8 + ( i * 32 ),
            new Uint8Array( hash.buffer, 0, 32 )
        );
    }

    private _unsafe_readTxHashesBuff( nTxs?: number ): ArrayBuffer
    {
        return this._unsafe_read(
            this.config.startHashesU8,
            typeof nTxs === "number" ? nTxs * TX_HASH_SIZE : this.config.allHashesSize
        );
    }

    private _unsafe_readTxIndexesBuff( nTxs?: number ): Uint32Array
    {
        nTxs = nTxs ?? this.config.maxTxs - 1;
        if( nTxs <= 0 ) return new Uint32Array(0);

        return new Uint32Array(
            this._unsafe_read(
                N_MUTEX_BYTES,
                nTxs * 4
            )
        )
    }

    private _readTxHashes(): MempoolTxHash[]
    {
        const nTxs = this._getTxCount();
        const hashes: MempoolTxHash[] = new Array( nTxs );

        for( let i = 0; i < nTxs; i++ )
        {
            hashes[i] = new Int32Array(
                this._readTxHashAt( i ).buffer
            ) as MempoolTxHash;
        }

        return hashes;
    }

    private async _getOnlyPresentHashesIndexes( hashes: MempoolTxHashLike[] ): Promise<MempoolTxHash[]>
    {
        await this._makeSureNoDrop();
        this._incrementReadingPeers();
        
        const realHashes = this._readTxHashes();

        this._decrementReadingPeers();

        return hashes
        .map( forceMempoolTxHash )
        .filter( hash => realHashes.some( realHash => eqMempoolTxHash( hash, realHash ) ) );
    }

    private _incrementAppendQueue(): number
    {
        return Atomics.add( this.int32View, APPEND_QUEQUE_I32_IDX, 1 );
    }

    private _decrementAppendQueue(): number
    {
        return Atomics.sub( this.int32View, APPEND_QUEQUE_I32_IDX, 1 );
    }

    private async _waitAppendQueue(): Promise<void>
    {
        let otherInQueque = this._incrementAppendQueue();
        while( otherInQueque > 0 )
        {
            const value = await unwrapWaitAsyncResult(
                Atomics.waitAsync(
                    this.int32View,
                    APPEND_QUEQUE_I32_IDX,
                    otherInQueque + 1
                    // no timeout, we wait until all the other appends finish
                )
            );
            switch( value )
            {
                // someone else finished
                // there might be others waiting but we don't care
                case "ok": return;
                case "timed-out": throw new Error("Timed out waiting for append queue");
                // value changed between increment and wait
                // we need to check if it is 0 now, and wait if not (again)
                case "not-equal":
                    otherInQueque = Atomics.load( this.int32View, APPEND_QUEQUE_I32_IDX ) - 1;
                    break;
                default: throw new Error("Unexpected value from Atomics.waitAsync");
            }
        }
    }

    private _isHashPresent( hash: MempoolTxHash, nTxs?: number ): boolean
    {
        nTxs = nTxs ?? this._getTxCount();
        for( let i = 0; i < nTxs; i++ )
        {
            if(
                eqMempoolTxHash(
                    hash,
                    new Int32Array(
                        this._readTxHashAt( i ).buffer
                    ) as MempoolTxHash
                )
            ) return true
        }
        return false;
    }

    private async _initAppend(): Promise<void>
    {
        await this._waitAppendQueue();
        await this._makeSureNoDrop();
        this._incrementReadingPeers();
    }

    private _deinitAppend(): void
    {
        this._decrementReadingPeers();
        this._decrementAppendQueue();
        // notify ONLY ONE of the other appenders
        Atomics.notify( this.int32View, APPEND_QUEQUE_I32_IDX, 1 );
    }

    private _getAppendInfos(): [ tx_count: number, aviable_space: number ]
    {
        const buff = new ArrayBuffer( 4 );
        const u8 = new Uint8Array( buff );
        const i32 = new Int32Array( buff );
        
        i32[0] = Atomics.load( this.int32View, APPEND_INFO_BYTES_I32_IDX );
        
        return [
            u8[0],
            ( u8[1] << 16 ) | 
            ( u8[2] << 8  ) |
            u8[3]
        ];
    }

    private _readAviableSpace(): number
    {
        const buff = new ArrayBuffer( 4 );
        const u8 = new Uint8Array( buff );
        const i32 = new Int32Array( buff );

        i32[0] = Atomics.load( this.int32View, APPEND_INFO_BYTES_I32_IDX );
        return (
            ( u8[1] << 16 ) | 
            ( u8[2] << 8  ) |
            u8[3]
        );
    }
    private _writeAviableSpace( n: number ): void
    {
        n = n & 0xffffff;

        Atomics.store( this.u8View, AVIABLE_SPACE_U8_IDX + 2, n & 0xff );
        Atomics.store( this.u8View, AVIABLE_SPACE_U8_IDX + 1, (n >> 8) & 0xff );
        Atomics.store( this.u8View, AVIABLE_SPACE_U8_IDX, (n >> 16) & 0xff );
    }
    private _decrementAviableSpace( decr: number ): void
    {
        // cannot sub because not alligned
        this._writeAviableSpace( this._readAviableSpace() - decr );
    }
}