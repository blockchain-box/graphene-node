import HyperDHT, { KeyPair } from 'hyperdht';
import { Logger, pipeTcpServer } from '@grph-net/net';

interface ServerOptions {
    logger?: Logger;
    silent?: boolean;
    secure?: boolean;
    seed?: string;
    host?: string;
    port?: number;
    udp?: boolean;
}
interface ServerInfo {
    type: 'server';
    state: string | null;
    secure: boolean;
    port: number | undefined;
    host: string | undefined;
    protocol: string;
    seed: string | undefined;
    key: string;
    publicKey: string;
}
declare class GrphServer {
    logger: Logger;
    dht: InstanceType<typeof HyperDHT>;
    stats: Record<string, number>;
    server: ReturnType<InstanceType<typeof HyperDHT>['createServer']> | null;
    keyPair: KeyPair | null;
    seed: Buffer | null;
    state: string | null;
    connection: ReturnType<typeof pipeTcpServer> | null;
    refreshInterval: ReturnType<typeof setInterval> | null;
    activeConnections: Map<string, number>;
    args: ServerOptions;
    secure: boolean;
    constructor(opts?: ServerOptions);
    generateKeyPair(seed?: string): KeyPair;
    start(args: ServerOptions, callback?: () => void): Promise<void>;
    handleTCP(c: any, args: ServerOptions): void;
    handleUDP(c: any, args: ServerOptions): void;
    get key(): string;
    resume(): Promise<void>;
    pause(): Promise<void>;
    destroy(): Promise<void>;
    put(data: string | Buffer, opts?: Record<string, unknown>): Promise<number>;
    get(opts?: Record<string, unknown>): Promise<{
        seq: number;
        value: string;
    } | null>;
    get info(): ServerInfo;
}

export { GrphServer, type ServerInfo, type ServerOptions, GrphServer as default };
