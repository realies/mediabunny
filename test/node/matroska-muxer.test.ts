import { expect, test } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Input } from '../../src/input.js';
import { BufferSource, FilePathSource } from '../../src/source.js';
import { ADTS, ALL_FORMATS } from '../../src/input-format.js';
import { EncodedPacketSink } from '../../src/media-sink.js';
import { Output } from '../../src/output.js';
import { BufferTarget } from '../../src/target.js';
import { MkvOutputFormat, Mp4OutputFormat } from '../../src/output-format.js';
import { Conversion } from '../../src/conversion.js';
import { assert } from '../../src/misc.js';
import { EncodedAudioPacketSource, EncodedVideoPacketSource } from '../../src/media-source.js';
import { EncodedPacket } from '../../src/packet.js';
import { EBMLId, readElementHeader, readSignedInt, readUnsignedInt } from '../../src/matroska/ebml.js';
import { FileSlice } from '../../src/reader.js';
import { guessDescriptionForAudio } from '../../src/codec.js';

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
		// Priming can cover several packets, as the common 2112-sample AAC priming does
		const delay = codec === 'opus' ? 312 : packetFrames + 24;
		const frames = 3 * packetFrames - delay - 24;
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
		for (let i = 0; i < 3; i++) {
			const payload = codec === 'mp3'
				? new Uint8Array(576)
				: codec === 'pcm-s16' ? new Uint8Array(packetFrames * 2) : new Uint8Array([0xf8, 0]);
			if (codec === 'mp3') {
				payload.set([0xff, 0xfb, 0xb4, 0xc0]);
			}
			const timestamp = (i * packetFrames - (codec === 'opus' && i === 0 ? 0 : delay)) / sampleRate;
			// Matroska input reports millisecond durations, but a PCM payload length gives the exact sample count
			const duration = codec === 'pcm-s16' ? 0.021 : packetFrames / sampleRate;
			await source.add(new EncodedPacket(payload, 'key', timestamp, duration), { decoderConfig });
		}
		await output.finalize();
		const bytes = new Uint8Array(output.target.buffer!);
		expect(readMatroskaIntegers(bytes, EBMLId.DiscardPadding)).toEqual(codec === 'opus'
			? [500000]
			: [-Math.round(1e9 * packetFrames / sampleRate), -500000, 500000]);
		expect(readMatroskaIntegers(bytes, EBMLId.CodecDelay)).toEqual(codec === 'opus' ? [6500000] : []);
		expect(readMatroskaIntegers(bytes, EBMLId.SeekPreRoll)).toEqual(codec === 'opus' ? [80000000] : []);
	});
}

test('Matroska Segment duration leaves out discarded tail audio', async () => {
	const decoderConfig = { codec: 'pcm-s16', sampleRate: 48000, numberOfChannels: 1 };
	const trimmed = new EncodedAudioPacketSource('pcm-s16');
	const other = new EncodedAudioPacketSource('pcm-s16');
	const output = new Output({ format: new MkvOutputFormat(), target: new BufferTarget() });
	// Two 1000-sample blocks with a 24-sample tail trim present 41.17 ms, though their whole-millisecond timestamps and
	// durations add up to 42 ms, so the other track's end at 41.25 ms is the latest
	const block = 1000 / 48000;
	output.addAudioTrack(trimmed, { presentationTimestamp: 0, presentationDuration: 1976 / 48000 });
	output.addAudioTrack(other);
	await output.start();
	for (let i = 0; i < 2; i++) {
		await trimmed.add(new EncodedPacket(new Uint8Array(2000), 'key', i * block, block), { decoderConfig });
	}
	await other.add(new EncodedPacket(new Uint8Array(3960), 'key', 0, 0.04125), { decoderConfig });
	await output.finalize();

	using input = new Input({ source: new BufferSource(output.target.buffer!), formats: ALL_FORMATS });
	expect(await input.getDurationFromMetadata()).toBe(0.04125);
});

// Matroska input rounds packet timestamps and durations to whole milliseconds, so exact presentation has to count each
// packet's samples from its own framing
for (const codec of ['aac', 'flac', 'ac3', 'eac3', 'dts'] as const) {
	test(`Exact ${codec} presentation counts the samples of Matroska input exactly`, async () => {
		const sampleRate = 44100;
		const packetFrames = { aac: 1024, flac: 4096, ac3: 1536, eac3: 1536, dts: 512 }[codec];
		const payload = new Uint8Array(codec === 'ac3' ? 138 : codec === 'eac3' ? 192 : 96);
		payload.set({
			aac: [],
			flac: [0xff, 0xf8, 0xc9, 0x08], // A 4096-sample block
			ac3: [0x0b, 0x77, 0, 0, 0x40, 0x40], // A syncframe at the lowest bit rate
			eac3: [0x0b, 0x77, 0x00, 0x5f, 0x74, 0x80], // A syncframe of six blocks
			dts: [0x7f, 0xfe, 0x80, 0x01, 0xfc, 0x3c, 0x05, 0xf0, 0xa1, 0xe0], // A core frame of 512 samples
		}[codec]);
		const decoderConfig = {
			codec: { aac: 'mp4a.40.2', flac: 'flac', ac3: 'ac-3', eac3: 'ec-3', dts: 'dtsc' }[codec],
			sampleRate,
			numberOfChannels: 2,
			description: codec === 'aac'
				? new Uint8Array([0x12, 0x10])
				: codec === 'flac'
					? guessDescriptionForAudio({ codec: 'flac', sampleRate, numberOfChannels: 2 }) as Uint8Array
					: undefined,
		};
		const source = new EncodedAudioPacketSource(codec);
		const mkv = new Output({ format: new MkvOutputFormat(), target: new BufferTarget() });
		mkv.addAudioTrack(source);
		await mkv.start();
		for (let i = 0; i < 5; i++) {
			await source.add(
				new EncodedPacket(payload, 'key', i * packetFrames / sampleRate, packetFrames / sampleRate),
				{ decoderConfig },
			);
		}
		await mkv.finalize();

		using input = new Input({ source: new BufferSource(mkv.target.buffer!), formats: ALL_FORMATS });
		const track = await input.getPrimaryAudioTrack();
		assert(track);
		const inputConfig = await track.getDecoderConfig();
		assert(inputConfig);
		const packets: EncodedPacket[] = [];
		for await (const packet of new EncodedPacketSink(track).packets()) {
			packets.push(packet);
		}

		const head = 100;
		const tail = 200;
		for (const format of [new MkvOutputFormat(), new Mp4OutputFormat()]) {
			const exactSource = new EncodedAudioPacketSource(codec);
			const output = new Output({ format, target: new BufferTarget() });
			output.addAudioTrack(exactSource, {
				presentationTimestamp: packets[0]!.timestamp + head / sampleRate,
				presentationDuration: (5 * packetFrames - head - tail) / sampleRate,
			});
			await output.start();
			for (const packet of packets) {
				await exactSource.add(packet, { decoderConfig: inputConfig });
			}
			await output.finalize();
			const bytes = Buffer.from(output.target.buffer!);
			if (format instanceof MkvOutputFormat) {
				expect(readMatroskaIntegers(bytes, EBMLId.DiscardPadding))
					.toEqual([-Math.round(1e9 * head / sampleRate), Math.round(1e9 * tail / sampleRate)]);
			} else {
				const stts = bytes.indexOf('stts');
				expect([bytes.readUInt32BE(stts + 8), bytes.readUInt32BE(stts + 16)]).toEqual([1, packetFrames]);
				const elst = bytes.indexOf('elst');
				expect(bytes.readInt32BE(elst + 16 + 12 * (bytes.readUInt32BE(elst + 8) - 1))).toBe(head);
			}
		}
	});
}

test('Exact presentation refuses Vorbis, whose packet lengths depend on the packet before', async () => {
	const decoderConfig = { codec: 'vorbis', sampleRate: 44100, numberOfChannels: 2 };
	for (const format of [new MkvOutputFormat(), new Mp4OutputFormat()]) {
		const source = new EncodedAudioPacketSource('vorbis');
		const output = new Output({ format, target: new BufferTarget() });
		output.addAudioTrack(source, { presentationTimestamp: 0, presentationDuration: 1 });
		await output.start();
		await expect(source.add(new EncodedPacket(new Uint8Array(1), 'key', 0, 0.01), {
			decoderConfig: { ...decoderConfig, description: guessDescriptionForAudio(decoderConfig) as Uint8Array },
		})).rejects.toThrow('Exact audio presentation is not supported for vorbis.');
	}
});
