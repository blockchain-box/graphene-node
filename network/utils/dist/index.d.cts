interface GeneratedResult {
    seed: Buffer;
    keyPair: {
        publicKey: Buffer;
        secretKey: Buffer;
    };
    hmac: Buffer;
    capability: Buffer;
    invite: string;
}
interface ParsedInvite {
    version: number;
    publicKey: Buffer;
    capability: Buffer;
}
declare function generate(seed?: string | Buffer): GeneratedResult;
declare function parse(invite: string): ParsedInvite;
declare function randomSeed(): string;

export { type GeneratedResult, type ParsedInvite, generate, parse, randomSeed };
