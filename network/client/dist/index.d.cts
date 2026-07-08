import HyperDHT, { KeyPair } from 'hyperdht';
import { Logger, createTcpProxy, createUdpFramedProxy } from '@grph-net/net';

interface ClientOptions {
    logger?: Logger;
    silent?: boolean;
    key: string;
    secure?: boolean;
}
interface ConnectOptions {
    port?: number;
    host?: string;
    udp?: boolean;
}
interface ClientInfo {
    type: 'client';
    state: string | undefined;
    secure: boolean;
    port: number | undefined;
    host: string | undefined;
    protocol: string;
    key: string;
    publicKey: string;
}
declare class GrphClient {
    logger: Logger;
    seed: string;
    secure: boolean;
    keyPair: KeyPair | undefined;
    publicKey: Buffer;
    dht: InstanceType<typeof HyperDHT>;
    stats: Record<string, number>;
    proxy: ReturnType<typeof createTcpProxy> | ReturnType<typeof createUdpFramedProxy>['proxySocket'] | null;
    clients: Map<string, unknown> | null;
    state: string | undefined;
    args: ConnectOptions;
    constructor(opts: ClientOptions);
    connect(options?: ConnectOptions, callback?: () => void): Promise<void>;
    handleTCP(options: ConnectOptions, callback?: () => void): void;
    handleUDP(options: ConnectOptions, callback?: () => void): void;
    resume(): Promise<void>;
    pause(): Promise<void>;
    destroy(): Promise<void>;
    get(opts?: Record<string, unknown>): Promise<{
        seq: number;
        value: string;
    } | null>;
    get info(): ClientInfo;
    static ping(key: string, dht?: InstanceType<typeof HyperDHT>): Promise<Record<string, unknown> | null>;
}

export { type ClientInfo, type ClientOptions, type ConnectOptions, GrphClient, GrphClient as default };
