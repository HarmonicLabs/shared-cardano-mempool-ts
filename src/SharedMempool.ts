import { getMaxTxAllowed, isSupportedMempoolSize, SupportedMempoolSize } from "./types/SupportedMempoolSize";
import { IndexedHash, insertSortedHash } from "./types/IndexedHash";
import { MempoolAppendResult, MempoolAppendStatus } from "./types/MempoolAppendResult";
import { MempoolIndex } from "./types/MempoolIndex";
import { MempoolTx } from "./types/MempoolTx";
import { eqMempoolTxHash, forceMempoolTxHash, isMempoolTxHashLike, MempoolTxHash, MempoolTxHashBI, MempoolTxHashLike, U8Arr32 } from "./types/MempoolTxHash";
import { concatUint8Arr } from "./utils/concatUint8Arr";
import { unwrapWaitAsyncResult } from "./utils/unwrapWaitAsyncResult";

const hasSharedArrayBuffer = typeof globalThis.SharedArrayBuffer !== 'undefined';

const PERFORMING_DROP = 0;
const NOT_PERFORMING_DROP = 1;

const N_MUTEX_BYTES = 16;
const N_MUTEX_U8 = 16;
const N_MUTEX_I32 = N_MUTEX_BYTES / 4;
const N_MUTEX_BI64 = N_MUTEX_BYTES / 8;

const TX_COUNT_U8_OFFSET = 8;

const READING_PEERS_IDX_I32 = 1;
const APPEND_BYTES_IDX_I32 = 2;
const APPEND_QUEQUE_IDX_I32 = 3;

const APPEND_BYTES_IDX_U8 = APPEND_BYTES_IDX_I32 * 4;
const AVIABLE_SPACE_IDX_U8 = APPEND_BYTES_IDX_U8 + 1;

export interface SharedMempoolArgs {
    
}

const defaultConfig: SharedMempoolArgs = {

};

export interface SharedMempoolConfig extends SharedMempoolArgs
{
    readonly size: SupportedMempoolSize,
    readonly maxTxs: number,
    readonly allHashesSize: number
    readonly startHashesU8: number,
    readonly startTxsU8: number,
}

export interface IMempool {
    getTxCount(): Promise<number>;
    readTxHashes(): Promise<U8Arr32[]>;
    readTxs( hashes: MempoolTxHashLike[] ): Promise<MempoolTx[]>;
    append( hash: MempoolTxHashLike, tx: Uint8Array ): Promise<MempoolAppendResult>;
    drop( hashes: MempoolTxHashLike[] ): Promise<void>;
}

export class SharedMempool implements IMempool
{
    private readonly sharedMemory: SharedArrayBuffer;
    private readonly bi64View: BigUint64Array;
    /**
     * TODO: add "performing unsafe read" mutex, to be used for large (continous) reads
        [
            PERFORMING_DROP mutex,
            reading_peers_count,
            tx_count ( 1 byte )| aviable_space ( 3 bytes ),
            append queque, // 4 bytes probably unnecessary
            // end of mutex bytes (N_MUTEX_BYTES)
            ...indexes,
            ...hashes, // TODO: add "previous dropped hashes" to avoid re-appending them
            ...txs
        ]
     */
    private readonly int32View: Int32Array;
    private readonly u8View: Uint8Array;
    readonly config: SharedMempoolConfig;

    static initMemory( size: SupportedMempoolSize ): SharedArrayBuffer
    static initMemory( buff: SharedArrayBuffer ): SharedArrayBuffer
    static initMemory( buff: SupportedMempoolSize | SharedArrayBuffer ): SharedArrayBuffer
    {
        const size = typeof buff === 'number' ? buff : buff?.byteLength;
        buff = buff instanceof SharedArrayBuffer ? buff : new SharedArrayBuffer( size );
        if( !isSupportedMempoolSize( size ) ) throw new Error(`Invalid SharedMempool size: ${size}`);

        const view = new Uint32Array( buff );
        view.fill( 0 );

        const mempool = new SharedMempool( buff );
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
        if (!hasSharedArrayBuffer) throw new Error('SharedArrayBuffer not supported, cannot create SharedMempool');

        const size = sharedMemory.byteLength;
        if( !isSupportedMempoolSize( size ) ) throw new Error(`Invalid SharedMempool size: ${size}`);

        this.sharedMemory = sharedMemory;
        this.bi64View = new BigUint64Array( sharedMemory );
        this.int32View = new Int32Array( sharedMemory );
        this.u8View = new Uint8Array( sharedMemory );

        const maxTxs = getMaxTxAllowed( size );
        const startHashesU8 = N_MUTEX_BYTES + ( maxTxs * 8 );
        const startTxsU8 = startHashesU8 + ( maxTxs * 32 );

        this.config = Object.freeze({
            ...defaultConfig,
            ...config,
            size,
            maxTxs,
            allHashesSize: maxTxs * 32,
            startHashesU8,
            startTxsU8
        });
    }

    async getTxCount(): Promise<number>
    {
        await this._makeSureNoDrop();
        this._incrementReadingPeers();
        const n = this._getTxCount();
        this._decrementReadingPeers();
        return n;
    }

    async readTxHashes(): Promise<U8Arr32[]>
    {
        await this._makeSureNoDrop();
        this._incrementReadingPeers();

        const hashes = this._readTxHashesBI();

        this._decrementReadingPeers();

        return hashes.map( hash => new Uint8Array( hash.buffer ) as U8Arr32 );
    }

    async readTxs( hashes: MempoolTxHashLike[] ): Promise<MempoolTx[]>
    {
        if( hashes.length === 0 ) return [];
        hashes = hashes.map( forceMempoolTxHash );
        await this._makeSureNoDrop();
        this._incrementReadingPeers();

        const _txs = this._readTxs( hashes as MempoolTxHash[] );

        this._decrementReadingPeers();

        if( _txs.length === 0 ) return [];
        const [ buffs, indexes, indexedHashes ] = _txs;

        const buff = concatUint8Arr( buffs );
        let offset = 0;
        const txs = new Array<MempoolTx>( indexes.length );
        let hashView: Uint8Array; 
        for( let i = 0; i < indexes.length; i++ )
        {
            const { size } = indexes[i];
            const hash = new Uint8Array( 32 ) as U8Arr32
            hashView = new Uint8Array( indexedHashes[i][0].buffer );
            hash.set( hashView );
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
                status: MempoolAppendStatus.MaxReached,
                nTxs,
                aviableSpace
            };
        }

        hash = forceMempoolTxHash( hash );

        if( this._isHashPresent( hash, nTxs ) )
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
            { index: 0, size: 0 } as MempoolIndex :
            this._readTxIndexAt( nTxs - 1 )
        );
        const thisTxIndexStart = lastTxIndex.index + lastTxIndex.size;

        this._writeTxHashAt( nTxs, new BigUint64Array( hash.buffer ) as MempoolTxHashBI );
        // UNSAFE WRITE
        // writes without lock (no `Atomics`)
        // this should be fine since only one append is allowed at a time
        this._unsafe_writeTxAt( thisTxIndexStart, tx );
        this._writeTxIndexAt(
            nTxs,
            { index: thisTxIndexStart, size: tx.byteLength } as MempoolIndex
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
        hashes = hashes.filter( isMempoolTxHashLike ).map( forceMempoolTxHash );

        await this._initDrop();

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
            const view = new Uint32Array( this.sharedMemory, N_MUTEX_U8 );
            view.fill( 0 );

            this._writeAviableSpace(
                this.config.size - this.config.startTxsU8
            );
            this._deinitDrop();
            return;
        }
        

        this._deinitDrop();
    }

    private _moveTx( from: number, to: number, toIndex: MempoolIndex )
    {
        const fromIndex = this._readTxIndexAt( from );

        // move hash
        this._writeTxHashAt( to, this._readTxHashAtBI( from ) );
        // clear dropped hash
        this._writeTxHashAt( from, new BigUint64Array( new ArrayBuffer( 32 ) ) as MempoolTxHashBI );

        // move tx
        this._unsafe_writeTxAt(
            toIndex.index,
            this._unsafe_continousRead( fromIndex.index, fromIndex.size )
        );
        // do not clear dropped tx,
        // we never access it again and will be overwritten by new txs

        this._writeTxIndexAt(
            to,
            {
                index: toIndex.index,
                size: fromIndex.size
            }
        );
        // clear dropped index
        this._writeTxIndexAt(
            from,
            { index: 0, size: 0 }
        );
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
        let someoneElseIsDropping = false;
        while( !someoneElseIsDropping )
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
            someoneElseIsDropping = oldState !== NOT_PERFORMING_DROP;
        }

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

    private reorg()
    {

    }

    /**
     * UNSAFE
     * ONLY CALL AFTER AWAITING `_makeSureNoDrop`
     */
    private _incrementReadingPeers(): void
    {
        Atomics.add( this.int32View, READING_PEERS_IDX_I32, 1 );
    }

    private _decrementReadingPeers(): void
    {
        const prev = Atomics.sub( this.int32View, READING_PEERS_IDX_I32, 1 );
        if( prev <= 1 )
        {
            Atomics.notify( this.int32View, READING_PEERS_IDX_I32 );
        }
    }

    private _incrementTxCount(): void
    {
        Atomics.add( this.u8View, TX_COUNT_U8_OFFSET, 1 );
    }

    private async _makeSureNoDrop(): Promise<void>
    {
        // not-equal there was no drop;
        // timed-out means it took too long;
        // ok means there was a drop and it ended;
        await unwrapWaitAsyncResult(
            Atomics.waitAsync(
                this.int32View,
                0,
                PERFORMING_DROP,
                3000 // 3 seconds timeout
                // (`drop` might wait 1 seconds for reading peers to finish)
            )
        );
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
                    READING_PEERS_IDX_I32,
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
        return Atomics.load( this.int32View, READING_PEERS_IDX_I32 );
    }

    private _writeTxIndexAt( i: number, index: MempoolIndex ): void
    {
        const offset = N_MUTEX_BI64 + i;

        const buff = new ArrayBuffer( 8 );
        const uint32View = new Uint32Array( buff );
        const bi64View = new BigUint64Array( buff );

        uint32View[0] = index.index;
        uint32View[1] = index.size;

        Atomics.store( this.bi64View, offset, bi64View[0] );
    }

    private _readTxIndexAt( i: number ): MempoolIndex
    {
        const offset = N_MUTEX_BI64 + i;

        const buff = new ArrayBuffer( 8 );
        const uint32View = new Uint32Array( buff );
        const bi64View = new BigUint64Array( buff );

        bi64View[0] = Atomics.load( this.bi64View, offset );

        return {
            index: uint32View[0],
            size: uint32View[1]
        };
    }

    private _readAllIndexes(): MempoolIndex[]
    {
        const nTxs = this._getTxCount();
        const indexes: MempoolIndex[] = new Array( nTxs );

        const finalIdx = N_MUTEX_BI64 + nTxs;

        for( let offset = N_MUTEX_BI64; offset < finalIdx; offset++ )
        {
            const i = offset - N_MUTEX_BI64;
            indexes[i] = this._readTxIndexAt( i );
        }

        return indexes;
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

    private _readTxHashAtBI( i: number ): MempoolTxHashBI
    {
        const buff = new ArrayBuffer( 32 );
        const hash = new BigUint64Array( buff ) as MempoolTxHashBI;

        let offset = (this.config.startHashesU8 / 8) + ( i * 4 );

        hash[0] = Atomics.load( this.bi64View, offset );
        hash[1] = Atomics.load( this.bi64View, ++offset );
        hash[2] = Atomics.load( this.bi64View, ++offset );
        hash[3] = Atomics.load( this.bi64View, ++offset );
        return hash;
    }

    private _writeTxHashAt( i: number, hash: MempoolTxHashBI ): void
    {
        let offset = (this.config.startHashesU8 / 8) + ( i * 4 );

        Atomics.store( this.bi64View,   offset, hash[0] );
        Atomics.store( this.bi64View, ++offset, hash[1] );
        Atomics.store( this.bi64View, ++offset, hash[2] );
        Atomics.store( this.bi64View, ++offset, hash[3] );
    }

    /**
     * UNSAFE
     * 
     * only call inside `append` method
     */
    private _unsafe_writeTxAt( i: number, tx: Uint8Array ): void
    {
        const offset = (this.config.startTxsU8 / 8) + i;
        // UNSAFE WRITE
        this.u8View.set( tx, offset );
    }

    private _readTxHashesBI(): MempoolTxHashBI[]
    {
        const nTxs = this._getTxCount();
        const hashes: MempoolTxHashBI[] = new Array( nTxs );

        for( let i = 0; i < nTxs; i++ )
        {
            hashes[i] = this._readTxHashAtBI( i );
        }

        return hashes;
    }

    private _unsafe_readTxHashesBuff(): Uint8Array
    {
        return this._unsafe_continousRead( this.config.startHashesU8, this.config.allHashesSize );
    }
    private _readTxHashes(): MempoolTxHash[]
    {
        const nTxs = this._getTxCount();
        const hashes: MempoolTxHash[] = new Array( nTxs );

        for( let i = 0; i < nTxs; i++ )
        {
            hashes[i] = new Int32Array(
                this._readTxHashAtBI( i ).buffer
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

    private _unsafe_continousRead( offset: number, length: number ): Uint8Array
    {
        const buff = new ArrayBuffer( length );
        const u8 = new Uint8Array( buff );
        u8.set( this.u8View.subarray( offset, offset + length ));
        return u8;
    }
    private _continousRead( offset: number, length: number ): Uint8Array
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

    private _readTxs( hashes: MempoolTxHash[] ): [ buffs: Uint8Array[], indexes: MempoolIndex[], indexedHashes: IndexedHash[] ] | []
    {
        const nTxs = this._getTxCount();
        const indexedHashes = this._unsafe_filterByHashPresent( hashes, nTxs );
        if( indexedHashes.length === 0 ) return [];

        const indexes = indexedHashes.map( ([ _hash, idx ]) => this._readTxIndexAt( idx ));

        const continousReads: MempoolIndex[] = [ { ...indexes[0] } ];
        let lastTxIndex: number = indexes[0].index;
        for( let i = 1; i < indexes.length; i++ )
        {
            const index = indexes[i];
            if( index.index === lastTxIndex + 1 )
            {
                continousReads[continousReads.length - 1].size += index.size;
            }
            else
            {
                continousReads.push({ ...index });
            }
            lastTxIndex = index.index;
        }

        const buffs = continousReads.map( ({ index, size }) => this._unsafe_continousRead( index, size ));
        
        return [ buffs, indexes, indexedHashes ];
    }

    private _incrementAppendQueue(): number
    {
        return Atomics.add( this.int32View, APPEND_QUEQUE_IDX_I32, 1 );
    }

    private _decrementAppendQueue(): number
    {
        return Atomics.sub( this.int32View, APPEND_QUEQUE_IDX_I32, 1 );
    }

    private async _waitAppendQueue(): Promise<void>
    {
        let otherInQueque = this._incrementAppendQueue();
        while( otherInQueque > 0 )
        {
            const value = await unwrapWaitAsyncResult(
                Atomics.waitAsync(
                    this.int32View,
                    APPEND_QUEQUE_IDX_I32,
                    otherInQueque + 1
                    // no timeout, we wait until all the other appends finish
                )
            );
            switch( value )
            {
                case "ok": return;
                case "timed-out": throw new Error("Timed out waiting for append queue");
                // value changed between increment and wait
                // we need to check if it is 0 now, and wait if not (again)
                case "not-equal":
                    otherInQueque = Atomics.load( this.int32View, APPEND_QUEQUE_IDX_I32 ) - 1;
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
                        this._readTxHashAtBI( i ).buffer
                    ) as MempoolTxHash
                )
            ) return true
        }
        return false;
    }

    private _unsafe_filterByHashPresent( hashes: MempoolTxHash[], nTxs?: number ): IndexedHash[]
    {
        if( hashes.length === 0 ) return [];

        nTxs = nTxs ?? this._getTxCount();
        const filtered: ([ hash: MempoolTxHash, idx: number ])[] = [];
        let len = 0;

        const buff = this._unsafe_readTxHashesBuff();

        const realHashes = new Array<MempoolTxHash>( this.config.maxTxs );
        for( let i = 0; i < this.config.allHashesSize; i++ )
        {
            realHashes[i] = new Int32Array(
                buff.buffer,
                i,
                8
            ) as MempoolTxHash;
        }

        for( let i = 0; i < nTxs; i++ )
        {
            const realHash = realHashes[i];
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
    private _filterByHashPresent( hashes: MempoolTxHash[], nTxs?: number ): IndexedHash[]
    {
        if( hashes.length === 0 ) return [];

        nTxs = nTxs ?? this._getTxCount();
        const filtered: ([ hash: MempoolTxHash, idx: number ])[] = [];
        let len = 0;
        for( let i = 0; i < nTxs; i++ )
        {
            const realHash = new Int32Array(
                this._readTxHashAtBI( i ).buffer
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
        Atomics.notify( this.int32View, APPEND_QUEQUE_IDX_I32, 1 );
    }

    private _getAppendInfos(): [ tx_count: number, aviable_space: number ]
    {
        const buff = new ArrayBuffer( 4 );
        const u8 = new Uint8Array( buff );
        const i32 = new Int32Array( buff );
        
        i32[0] = Atomics.load( this.int32View, APPEND_BYTES_IDX_I32 );
        
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

        i32[0] = Atomics.load( this.int32View, APPEND_BYTES_IDX_I32 );
        return (
            ( u8[1] << 16 ) | 
            ( u8[2] << 8  ) |
            u8[3]
        );
    }
    private _writeAviableSpace( n: number ): void
    {
        Atomics.and( this.int32View, APPEND_BYTES_IDX_I32,     0xff000000   );
        Atomics.or(  this.int32View, APPEND_BYTES_IDX_I32, n & 0x00ffffff );
        /*
        n = n & 0xffffff;

        Atomics.store( this.u8View, AVIABLE_SPACE_IDX_U8, (n >> 16) & 0xff );
        Atomics.store( this.u8View, AVIABLE_SPACE_IDX_U8 + 1, (n >> 8) & 0xff );
        Atomics.store( this.u8View, AVIABLE_SPACE_IDX_U8 + 2, n & 0xff );
        */
    }
    private _decrementAviableSpace( decr: number ): void
    {
        this._writeAviableSpace( this._readAviableSpace() - decr );
    }
}