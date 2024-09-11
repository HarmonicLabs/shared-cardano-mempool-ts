export function concatUint8Arr( arrays: Uint8Array[] ): Uint8Array
{
    const totalLength = arrays.reduce( (acc, arr) => acc + arr.length, 0 );
    const result = new Uint8Array( totalLength );

    let offset = 0;
    for( const arr of arrays )
    {
        result.set( arr, offset );
        offset += arr.length;
    }
    return result;
}

export function concatArrayBuffs( arrays: ArrayBuffer[] ): Uint8Array
{
    return concatUint8Arr( arrays.map( arr => new Uint8Array( arr ) ) );
}