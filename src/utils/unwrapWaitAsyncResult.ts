
type WaitResult = "not-equal" | "timed-out" | "ok";
export type WaitAsyncResult = { async: false; value: WaitResult; } | { async: true; value: Promise<WaitResult>; };

export async function unwrapWaitAsyncResult( { async, value }: WaitAsyncResult ): Promise<"ok" | "not-equal" | "timed-out">
{
    return async ? await value : value;
}