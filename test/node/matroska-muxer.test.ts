import { expect, test } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Input } from '../../src/input.js';
import { BufferSource, FilePathSource } from '../../src/source.js';
import { ADTS, ALL_FORMATS } from '../../src/input-format.js';
import { EncodedPacketSink } from '../../src/media-sink.js';
import { Output } from '../../src/output.js';
import { BufferTarget } from '../../src/target.js';
import { MkvOutputFormat } from '../../src/output-format.js';
import { Conversion } from '../../src/conversion.js';
import { assert } from '../../src/misc.js';
import { EncodedAudioPacketSource, EncodedVideoPacketSource } from '../../src/media-source.js';
import { EncodedPacket } from '../../src/packet.js';
import { EBMLId, readElementHeader, readSignedInt, readUnsignedInt } from '../../src/matroska/ebml.js';
import { FileSlice } from '../../src/reader.js';

const __dirname = fileURLToPath(new URL('.', import.meta.url));

test('Matroska muxer internally converts ADTS to AAC', async () => {
	using input = new Input({
		source: new FilePathSource(path.join(__dirname, '../public/sample3.aac')),
		formats: ALL_FORMATS,
	});

	expect(await input.getFormat()).toBe(ADTS);

	const inputTrack = await input.getPrimaryAudioTrack();
	assert(inputTrack);

	const inputDecoderConfig = await inputTrack.getDecoderConfig();
	expect(inputDecoderConfig!.description).toBeUndefined(); // ADTS input has no description

	const output = new Output({
		format: new MkvOutputFormat(),
		target: new BufferTarget(),
	});

	const conversion = await Conversion.init({ input, output, showWarnings: false });
	await conversion.execute();

	using outputAsInput = new Input({
		source: new BufferSource(output.target.buffer!),
		formats: ALL_FORMATS,
	});

	const outputTrack = await outputAsInput.getPrimaryAudioTrack();
	assert(outputTrack);

	expect(await outputTrack.getCodec()).toBe('aac');
	expect(await outputTrack.getSampleRate()).toBe(await inputTrack.getSampleRate());
	expect(await outputTrack.getNumberOfChannels()).toBe(await inputTrack.getNumberOfChannels());

	const outputDecoderConfig = await outputTrack.getDecoderConfig();
	expect(outputDecoderConfig!.description).toBeDefined();

	const outputSink = new EncodedPacketSink(outputTrack);

	let count = 0;
	for await (const packet of outputSink.packets()) {
		// Packets should NOT be ADTS frames (should not start with 0xFFF sync word)
		const isAdts = packet.data[0] === 0xff && (packet.data[1]! & 0xf0) === 0xf0;
		expect(isAdts).toBe(false);
		count++;
	}

	expect(count).toBe(4557);
});

test('Negative start timestamps', async () => {
	await testNegativeTimestampRoundTrip(
		Array.from({ length: 50 }, (_, index) => (index - 10) / 10),
		0.1,
		10,
	);
});

test('Wholly negative timestamps', async () => {
	await testNegativeTimestampRoundTrip([-1, -0.9, -0.8, -0.7, -0.6], 0.1, 10);
});

const testNegativeTimestampRoundTrip = async (timestamps: number[], duration: number, frameRate: number) => {
	const output = new Output({
		format: new MkvOutputFormat(),
		target: new BufferTarget(),
	});

	const source = new EncodedVideoPacketSource('vp8');
	output.addVideoTrack(source, { frameRate });

	await output.start();

	const meta = { decoderConfig: { codec: 'vp8', codedWidth: 1280, codedHeight: 720 } };
	const inputPackets = timestamps.map((timestamp, index) => new EncodedPacket(
		new Uint8Array(1024).fill(index),
		'key',
		timestamp,
		duration,
	));

	for (let i = 0; i < inputPackets.length; i++) {
		await source.add(inputPackets[i]!, i === 0 ? meta : undefined);
	}

	await output.finalize();

	using input = new Input({
		source: new BufferSource(output.target.buffer!),
		formats: ALL_FORMATS,
	});

	const track = await input.getPrimaryVideoTrack();
	assert(track);
	const sink = new EncodedPacketSink(track);

	const outputPackets: EncodedPacket[] = [];
	for await (const packet of sink.packets()) {
		outputPackets.push(packet);
	}

	expect(outputPackets.map(packet => ({
		timestamp: packet.timestamp,
		duration: packet.duration,
	}))).toEqual(inputPackets.map(packet => ({
		timestamp: packet.timestamp,
		duration: packet.duration,
	})));

	for (const inputPacket of inputPackets) {
		const outputPacket = await sink.getPacket(inputPacket.timestamp);
		assert(outputPacket);

		expect({
			timestamp: outputPacket.timestamp,
			duration: outputPacket.duration,
		}).toEqual({
			timestamp: inputPacket.timestamp,
			duration: inputPacket.duration,
		});
	}
};

const readMatroskaIntegers = (bytes: Uint8Array, wanted: number): number[] => {
	const slice = FileSlice.tempFromBytes(bytes);
	const values: number[] = [];
	while (slice.filePos < bytes.length) {
		const header = readElementHeader(slice);
		assert(header && header.size != null);
		const end = slice.filePos + header.size;
		if (header.id === wanted) {
			values.push(wanted === EBMLId.DiscardPadding
				? readSignedInt(slice, header.size)
				: readUnsignedInt(slice, header.size));
		} else if ([
			EBMLId.Segment, EBMLId.Tracks, EBMLId.TrackEntry, EBMLId.Cluster, EBMLId.BlockGroup,
		].includes(header.id)) {
			values.push(...readMatroskaIntegers(bytes.subarray(slice.filePos, end), wanted));
		}
		slice.skip(end - slice.filePos);
	}
	return values;
};

for (const codec of ['aac', 'mp3', 'opus', 'pcm-s16'] as const) {
	test(`Matroska exact ${codec} presentation writes signed padding and codec delay`, async () => {
		const sampleRate = 48000;
		const packetFrames = codec === 'aac' ? 1024 : codec === 'mp3' ? 1152 : codec === 'opus' ? 960 : 1000;
		const delay = codec === 'opus' ? 312 : 24;
		const frames = 2 * packetFrames - delay - 24;
		const source = new EncodedAudioPacketSource(codec);
		const output = new Output({ format: new MkvOutputFormat(), target: new BufferTarget() });
		const opusHead = new Uint8Array(19);
		opusHead.set([79, 112, 117, 115, 72, 101, 97, 100, 1, 1]);
		new DataView(opusHead.buffer).setUint16(10, delay, true);
		const decoderConfig = {
			codec: codec === 'aac' ? 'mp4a.40.2' : codec, numberOfChannels: 1,
			// An encoder may report a lower Opus rate, but PreSkip and packet durations still count 48 kHz samples
			sampleRate: codec === 'opus' ? 24000 : sampleRate,
			description: codec === 'opus' ? opusHead : codec === 'aac' ? new Uint8Array([0x11, 0x88]) : undefined,
		};
		output.addAudioTrack(source, { presentationTimestamp: 0, presentationDuration: frames / sampleRate });
		await output.start();
		for (let i = 0; i < 2; i++) {
			const payload = codec === 'mp3'
				? new Uint8Array(576)
				: codec === 'pcm-s16' ? new Uint8Array(packetFrames * 2) : new Uint8Array([0xf8, 0]);
			if (codec === 'mp3') payload.set([0xff, 0xfb, 0xb4, 0xc0]);
			const timestamp = (i * packetFrames - (codec === 'opus' && i === 0 ? 0 : delay)) / sampleRate;
			await source.add(
				new EncodedPacket(payload, 'key', timestamp, packetFrames / sampleRate), { decoderConfig },
			);
		}
		await output.finalize();
		const bytes = new Uint8Array(output.target.buffer!);
		expect(readMatroskaIntegers(bytes, EBMLId.DiscardPadding))
			.toEqual(codec === 'opus' ? [500000] : [-500000, 500000]);
		expect(readMatroskaIntegers(bytes, EBMLId.CodecDelay)).toEqual(codec === 'opus' ? [6500000] : []);
		expect(readMatroskaIntegers(bytes, EBMLId.SeekPreRoll)).toEqual(codec === 'opus' ? [80000000] : []);
	});
}
