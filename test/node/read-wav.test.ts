import { expect, test } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ALL_FORMATS, EncodedPacketSink, Input, FilePathSource, BufferSource } from '../../src/index.js';

const __dirname = fileURLToPath(new URL('.', import.meta.url));

test('Should handle WAV file with oversized ID3 chunk', async () => {
	const filePath = path.join(__dirname, '..', 'public/oversized-id3.wav');
	using input = new Input({
		source: new FilePathSource(filePath),
		formats: ALL_FORMATS,
	});

	const track = await input.getPrimaryAudioTrack();
	if (!track) {
		throw new Error('No audio track found');
	}

	const sink = new EncodedPacketSink(track);

	for await (const packet of sink.packets()) {
		void packet;
	}
});

test.each([
	{ name: 'mono PCM16 with blockAlign 4', blockAlign: 4 },
	{ name: 'stereo PCM24 with blockAlign 3', channels: 2, bits: 24, blockAlign: 3 },
	{ name: 'PCM with zero blockAlign', blockAlign: 0 },
	{ name: 'A-law with blockAlign 2', format: 6, bits: 8, blockAlign: 2 },
])('Should read whole frames for $name', async ({
	channels = 1, bits = 16, format = 1, blockAlign,
}) => {
	const frames = 4099;
	const sampleRate = 44100;
	const frameSize = channels * bits / 8;
	const samples = Buffer.from(Array.from({ length: frames * frameSize }, (_, i) => i % 251));
	const header = Buffer.alloc(44);
	header.write('RIFF');
	header.writeUInt32LE(header.length + samples.length + (samples.length & 1) - 8, 4);
	header.write('WAVE', 8);
	header.write('fmt ', 12);
	header.writeUInt32LE(16, 16);
	header.writeUInt16LE(format, 20);
	header.writeUInt16LE(channels, 22);
	header.writeUInt32LE(sampleRate, 24);
	header.writeUInt32LE(sampleRate * frameSize, 28);
	header.writeUInt16LE(blockAlign, 32);
	header.writeUInt16LE(bits, 34);
	header.write('data', 36);
	header.writeUInt32LE(samples.length, 40);

	using input = new Input({
		source: new BufferSource(Buffer.concat([header, samples, Buffer.alloc(samples.length & 1)])),
		formats: ALL_FORMATS,
	});
	const track = await input.getPrimaryAudioTrack();
	expect(track).not.toBeNull();
	expect(await track!.getDurationFromMetadata()).toBe(frames / sampleRate);
	expect(await input.computeDuration()).toBe(frames / sampleRate);

	const packets: Buffer[] = [];
	let through = 0;
	for await (const packet of new EncodedPacketSink(track!).packets()) {
		const count = Math.min(2048, frames - through);
		expect(packet.data.length).toBe(count * frameSize);
		expect(packet.timestamp).toBe(through / sampleRate);
		expect(packet.duration).toBe(count / sampleRate);
		packets.push(Buffer.from(packet.data));
		through += count;
	}
	expect(through).toBe(frames);
	expect(Buffer.concat(packets)).toEqual(samples);
});
