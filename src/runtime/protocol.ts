export interface NativeProbeResult {
	sdkVersion: string;
	sdkEntry: string;
	versions: NodeJS.ProcessVersions;
	platform: string;
	arch: string;
	checks: string[];
}

export interface ProbeMessage {
	requestId?: string;
	phase?: 'ready';
	result?: NativeProbeResult;
	error?: string;
}
