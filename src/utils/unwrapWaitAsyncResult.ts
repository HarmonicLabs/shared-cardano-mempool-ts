
export type WaitAsyncResult = { async: false; value: "not-equal" | "timed-out"; } | { async: true; value: Promise<"ok" | "timed-out">; };

export async function unwrapWaitAsyncResult( { async, value }: WaitAsyncResult ): Promise<"ok" | "not-equal" | "timed-out">
{
    return async ? await value : value;
}