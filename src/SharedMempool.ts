import { getMaxTxAllowed, isSupportedMempoolSize, SupportedMempoolSize } from "./SupportedMempoolSize";
import { IndexedHash, insertSortedHash } from "./types/IndexedHash";
import { MempoolAppendResult, MempoolAppendStatus } from "./types/MempoolAppendResult";
import { MempoolIndex } from "./types/MempoolIndex";
import { eqMempoolTxHash, forceMempoolTxHash, MempoolTxHash, MempoolTxHashBI, MempoolTxHashLike, U8Arr32 } from "./types/MempoTxHash";
import { unwrapWaitAsyncResult } from "./utils/unwrapWaitAsyncResult";

const hasSharedArrayBuffer = typeof globalThis.SharedArrayBuffer !== 'undefined';

const PERFORMING_DROP = 0;
const NOT_PERFORMING_DROP = 1;

const N_MUTEX_BYTES = 16;
const N_MUTEX_I32 = N_MUTEX_BYTES / 4;
const N_MUTEX_BI64 = N_MUTEX_BYTES / 8;

const TX_COUNT_U8_OFFSET = 8;

const READING_PEERS_IDX_I32 = 1;
const APPEND_BYTES_IDX_I32 = 2;
const APPEND_QUEQUE_IDX_I32 = 3;

const APPEND_BYTES_IDX_U8 = APPEND_BYTES_IDX_I32 * 4;
const AVIABLE_SPACE_IDX_U8 = APPEND_BYTES_IDX_U8 + 1;

export interface SharedMempoolArgs  s{
    
}

const defaultConfig: SharedMempoolArgs = {

};

export interface SharedMempoolConfig extends SharedMempoolArgs
{
    size: SupportedMempoolSize,
    maxTxs: number,
    startHashesU8: number,
    startTxsU8: number,
}

export class SharedMempool
{
    private readonly sharedMemory: SharedArrayBuffer;
    private readonly bi64View: BigUint64Array;
    /**
        [
            PERFORMING_DROP mutex,
            reading_peers_count,
            tx_count ( 1 byte )| aviable_space ( 3 bytes ),
            append queque, // 4 bytes probably unnecessary
            // end of mutex bytes (N_MUTEX_BYTES)
            ...indexes,
            ...hashes,
            ...txs
        ]
     */
    private readonly int32View: Int32Array;
    private readonly u8View: Uint8Array;
    readonly config: SharedMempoolConfig;

    constructor(
        sharedMemory: SharedArrayBuffer,
        config: SharedMempoolArgs
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
            startHashesU8,
            startTxsU8        });
    }

    private async makeSureNoDrop(): Promise<void>
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

    private async makeSureNoReadingPeers(): Promise<void>
    {
        let currentReadingPeers = this.getReadingPeers();
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
                    currentReadingPeers = this.getReadingPeers();
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

    private getReadingPeers(): number
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
        const nTxs = this._getTxNumber();
        const indexes: MempoolIndex[] = new Array( nTxs );

        const finalIdx = N_MUTEX_BI64 + nTxs;

        for( let offset = N_MUTEX_BI64; offset < finalIdx; offset++ )
        {
            const i = offset - N_MUTEX_BI64;
            indexes[i] = this._readTxIndexAt( i );
        }

        return indexes;
    }

    private _getTxNumber(): number
    {
        return Math.max(
            Math.min(
                Atomics.load( this.u8View, TX_COUNT_U8_OFFSET ),
                this.config.maxTxs
            ),
            0
        );
    }

    async getTxNumber(): Promise<number>
    {
        await this.makeSureNoDrop();
        this.incrementReadingPeers();
        const n = this._getTxNumber();
        this.decrementReadingPeers();
        return n;
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

    private _readTxAt( i: number, length: number ): Uint8Array
    {
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
        const nTxs = this._getTxNumber();
        const hashes: MempoolTxHashBI[] = new Array( nTxs );

        for( let i = 0; i < nTxs; i++ )
        {
            hashes[i] = this._readTxHashAtBI( i );
        }

        return hashes;
    }

    private _readTxHashes(): MempoolTxHash[]
    {
        const nTxs = this._getTxNumber();
        const hashes: MempoolTxHash[] = new Array( nTxs );

        for( let i = 0; i < nTxs; i++ )
        {
            hashes[i] = new Int32Array(
                this._readTxHashAtBI( i ).buffer
            ) as MempoolTxHash;
        }

        return hashes;
    }

    private async _filterOnlyPresentHashes( hashes: MempoolTxHashLike[] ): Promise<MempoolTxHash[]>
    {
        await this.makeSureNoDrop();
        this.incrementReadingPeers();
        
        const realHashes = this._readTxHashes();

        this.decrementReadingPeers();

        return hashes
        .map( forceMempoolTxHash )
        .filter( hash => realHashes.some( realHash => eqMempoolTxHash( hash, realHash ) ) );
    }

    private async _getOnlyPresentHashesIndexes( hashes: MempoolTxHashLike[] ): Promise<MempoolTxHash[]>
    {
        await this.makeSureNoDrop();
        this.incrementReadingPeers();
        
        const realHashes = this._readTxHashes();

        this.decrementReadingPeers();

        return hashes
        .map( forceMempoolTxHash )
        .filter( hash => realHashes.some( realHash => eqMempoolTxHash( hash, realHash ) ) );
    }

    async readTxHashes(): Promise<U8Arr32[]>
    {
        await this.makeSureNoDrop();
        this.incrementReadingPeers();

        const hashes = this._readTxHashesBI();

        this.decrementReadingPeers();

        return hashes.map( hash => new Uint8Array( hash.buffer ) as U8Arr32 );
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

    private _readTxs( hashes: MempoolTxHash[] ): [ buffs: Uint8Array[], indexes: MempoolIndex[], continousReads: MempoolIndex[] ] | []
    {
        const nTxs = this._getTxNumber();
        const indexedHashes = this._filterByHashPresent( hashes, nTxs );
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

        const buffs = continousReads.map( ({ index, size }) => this._continousRead( index, size ));
        
        return [ buffs, indexes, continousReads ];
    }

    async readTxs( hashes: MempoolTxHashLike[] ): Promise<Uint8Array[]>
    {
        if( hashes.length === 0 ) return [];
        hashes = hashes.map( forceMempoolTxHash );
        await this.makeSureNoDrop();
        this.incrementReadingPeers();

        const _txs = this._readTxs( hashes as MempoolTxHash[] );

        this.decrementReadingPeers();

        if( _txs.length === 0 ) return [];
        const [ buffs, indexes, continousReads ] = _txs;
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
        nTxs = nTxs ?? this._getTxNumber();
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

    private _filterByHashPresent( hashes: MempoolTxHash[], nTxs?: number ): IndexedHash[]
    {
        if( hashes.length === 0 ) return [];

        nTxs = nTxs ?? this._getTxNumber();
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
        await this.makeSureNoDrop();
        this.incrementReadingPeers();
    }

    private _deinitAppend(): void
    {
        this.decrementReadingPeers();
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
        n = n & 0xffffff;

        Atomics.store( this.u8View, AVIABLE_SPACE_IDX_U8, (n >> 16) & 0xff );
        Atomics.store( this.u8View, AVIABLE_SPACE_IDX_U8 + 1, (n >> 8) & 0xff );
        Atomics.store( this.u8View, AVIABLE_SPACE_IDX_U8 + 2, n & 0xff );
    }
    private _decrementAviableSpace( decr: number ): void
    {
        this._writeAviableSpace( this._readAviableSpace() - decr );
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
        this._unsafe_writeTxAt( thisTxIndexStart, tx );
        this._writeTxIndexAt(
            nTxs,
            { index: thisTxIndexStart, size: tx.byteLength } as MempoolIndex
        );

        // finalize tx write
        this.incrementTxCount();
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
        let someoneElseIsDropping = false;
        while( !someoneElseIsDropping )
        {
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

        await this.makeSureNoReadingPeers();

        

        Atomics.store( this.int32View, 0, NOT_PERFORMING_DROP );
        Atomics.notify( this.int32View, 0 );
    }

    private reorg()
    {

    }

    /**
     * UNSAFE
     * ONLY CALL AFTER AWAITING `makeSureNoDrop`
     */
    private incrementReadingPeers(): void
    {
        Atomics.add( this.int32View, READING_PEERS_IDX_I32, 1 );
    }

    private decrementReadingPeers(): void
    {
        const prev = Atomics.sub( this.int32View, READING_PEERS_IDX_I32, 1 );
        if( prev <= 1 )
        {
            Atomics.notify( this.int32View, READING_PEERS_IDX_I32 );
        }
    }

    private incrementTxCount(): void
    {
        Atomics.add( this.u8View, TX_COUNT_U8_OFFSET, 1 );
    }
}