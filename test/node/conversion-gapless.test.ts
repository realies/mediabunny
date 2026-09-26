import { expect, test } from 'vitest';
import {
	ALL_FORMATS, AudioSample, AudioSampleSink, BufferSource, BufferTarget, Conversion, CustomAudioDecoder,
	EncodedAudioPacketSource, EncodedPacket, Input, Mp4OutputFormat, Output, registerDecoder, WavOutputFormat,
} from '../../src/index.js';
import { AudioCodec } from '../../src/codec.js';
import { assert } from '../../src/misc.js';

class PaddedAacDecoder extends CustomAudioDecoder {
	static override supports(codec: AudioCodec) { return codec === 'aac'; }
	init() {}
	decode(packet: EncodedPacket) {
		this.onSample(new AudioSample({
			data: Float32Array.from({ length: 1024 }, (_, i) => i / 1024),
			format: 'f32', numberOfChannels: 1, sampleRate: 48000, timestamp: packet.timestamp,
		}));
	}

	flush() {}
	close() {}
}
registerDecoder(PaddedAacDecoder);

for (const transformed of [false, true]) {
	test(`Conversion crops decoder fill before audio processing (${transformed})`, async () => {
		const source = new EncodedAudioPacketSource('aac');
		const encoded = new Output({ format: new Mp4OutputFormat(), target: new BufferTarget() });
		encoded.addAudioTrack(source);
		await encoded.start();
		await source.add(new EncodedPacket(new Uint8Array([0]), 'key', 0, 1000 / 48000), {
			decoderConfig: {
				codec: 'mp4a.40.2', numberOfChannels: 1, sampleRate: 48000,
				description: new Uint8Array([0x11, 0x88]),
			},
		});
		await encoded.finalize();
		using input = new Input({ source: new BufferSource(encoded.target.buffer!), formats: ALL_FORMATS });
		let processedFrames = 0;
		const output = new Output({ format: new WavOutputFormat(), target: new BufferTarget() });
		const conversion = await Conversion.init({ input, output, audio: {
			codec: 'pcm-f32',
			process: transformed
				? (sample) => {
						processedFrames += sample.numberOfFrames;
						return sample;
					}
				: undefined,
		} });
		await conversion.execute();
		using result = new Input({ source: new BufferSource(output.target.buffer!), formats: ALL_FORMATS });
		const track = await result.getPrimaryAudioTrack();
		assert(track);
		expect(await track.computeDuration()).toBe(1000 / 48000);
		if (transformed) expect(processedFrames).toBe(1000);
		const pcm: number[] = [];
		for await (using sample of new AudioSampleSink(track).samples()) {
			const data = new Float32Array(sample.numberOfFrames);
			sample.copyTo(data, { planeIndex: 0, format: 'f32' });
			pcm.push(...data);
		}
		expect(pcm).toEqual(Array.from({ length: 1000 }, (_, i) => i / 1024));
	});
}

class PrimedOpusDecoder extends CustomAudioDecoder {
	private decodedFrames = 0;
	static override supports(codec: AudioCodec) { return codec === 'opus'; }
	init() {}
	decode(packet: EncodedPacket) {
		const preSkip = this.decodedFrames === 0 ? 288 : 0;
		const start = this.decodedFrames + preSkip;
		this.decodedFrames += 960;
		this.onSample(new AudioSample({
			data: Float32Array.from(
				{ length: 960 - preSkip - (packet.data[1] ? 480 : 0) }, (_, i) => (start + i) / 4096,
			),
			format: 'f32', numberOfChannels: 1, sampleRate: 48000, timestamp: packet.timestamp,
		}));
	}

	flush() {}
	close() {}
}
registerDecoder(PrimedOpusDecoder);

test('Opus in MP4 decodes the negative coded window and trims only the edit overlap', async () => {
	const source = new EncodedAudioPacketSource('opus');
	const encoded = new Output({ format: new Mp4OutputFormat(), target: new BufferTarget() });
	encoded.addAudioTrack(source);
	await encoded.start();
	const description = new Uint8Array(19);
	description.set([79, 112, 117, 115, 72, 101, 97, 100, 1, 1]);
	new DataView(description.buffer).setUint16(10, 312, true);
	for (let i = 0; i < 3; i++) {
		await source.add(new EncodedPacket(new Uint8Array([0xf8, 0]), 'key', (i * 960 - 336) / 48000, 960 / 48000), {
			decoderConfig: { codec: 'opus', numberOfChannels: 1, sampleRate: 48000, description },
		});
	}
	await encoded.finalize();
	using input = new Input({ source: new BufferSource(encoded.target.buffer!), formats: ALL_FORMATS });
	const track = await input.getPrimaryAudioTrack();
	assert(track);
	const config = await track.getDecoderConfig();
	assert(config?.description instanceof Uint8Array);
	expect(new DataView(config.description.buffer).getUint16(10, true)).toBe(288);
	const output = new Output({ format: new WavOutputFormat(), target: new BufferTarget() });
	await (await Conversion.init({ input, output, audio: { codec: 'pcm-f32' } })).execute();
	using result = new Input({ source: new BufferSource(output.target.buffer!), formats: ALL_FORMATS });
	const resultTrack = await result.getPrimaryAudioTrack();
	assert(resultTrack);
	const pcm: number[] = [];
	for await (using sample of new AudioSampleSink(resultTrack).samples()) {
		const data = new Float32Array(sample.numberOfFrames);
		sample.copyTo(data, { planeIndex: 0, format: 'f32' });
		pcm.push(...data);
	}
	expect(pcm).toEqual(Array.from({ length: 2544 }, (_, i) => (336 + i) / 4096));
});

test('Opus in MP4 rejects a missing non-silent tail beyond codec delay even with trim.start', async () => {
	const source = new EncodedAudioPacketSource('opus');
	const encoded = new Output({ format: new Mp4OutputFormat(), target: new BufferTarget() });
	encoded.addAudioTrack(source);
	await encoded.start();
	const description = new Uint8Array(19);
	description.set([79, 112, 117, 115, 72, 101, 97, 100, 1, 1]);
	new DataView(description.buffer).setUint16(10, 312, true);
	for (let i = 0; i < 3; i++) {
		// Drop 480 nonzero ramp samples from the last decoded packet; the edit still requires them.
		await source.add(new EncodedPacket(new Uint8Array([0xf8, i === 2 ? 1 : 0]), 'key',
			(i * 960 - 336) / 48000, 960 / 48000), {
			decoderConfig: { codec: 'opus', numberOfChannels: 1, sampleRate: 48000, description },
		});
	}
	await encoded.finalize();
	using input = new Input({ source: new BufferSource(encoded.target.buffer!), formats: ALL_FORMATS });
	const output = new Output({ format: new WavOutputFormat(), target: new BufferTarget() });
	const conversion = await Conversion.init({ input, output, trim: { start: 0.01 }, audio: { codec: 'pcm-f32' } });
	await expect(conversion.execute()).rejects.toThrow(
		'Missing 480 audio frames exceeds the fixed Opus delay (288 frames).',
	);
});
