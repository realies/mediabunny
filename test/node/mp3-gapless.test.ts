import { expect, test } from 'vitest';
import { BufferSource, EncodedPacketSink, Input, MP3 } from '../../src/index.js';
import { assert } from '../../src/misc.js';

for (const flags of [1, 3, 15]) {
	test(`LAME Xing fields trim encoder delay, decoder latency and padding (flags ${flags})`, async () => {
		const bytes = new Uint8Array(576 * 3);
		for (let i = 0; i < 3; i++) bytes.set([0xff, 0xfb, 0xb4, 0], i * 576);
		bytes.set([0x58, 0x69, 0x6e, 0x67], 36); // Xing
		const view = new DataView(bytes.buffer);
		view.setUint32(40, flags);
		view.setUint32(44, 2); // Two coded audio frames after the Xing frame
		let offset = 48;
		if (flags & 2) {
			view.setUint32(offset, bytes.length);
			offset += 4;
		}
		if (flags & 4) offset += 100;
		if (flags & 8) offset += 4;
		bytes.set([0x4c, 0x41, 0x4d, 0x45], offset); // LAME
		bytes.set([0x24, 0x02, 0x58], offset + 21); // Delay 576, padding 600
		using input = new Input({ source: new BufferSource(bytes), formats: [MP3] });
		const track = await input.getPrimaryAudioTrack();
		assert(track);
		const packets = [];
		for await (const packet of new EncodedPacketSink(track).packets()) packets.push(packet);
		expect(packets).toHaveLength(2);
		expect(packets[0]!.timestamp).toBe(-(576 + 529) / 48000);
		expect(packets[1]!.timestamp).toBe(47 / 48000);
		expect(packets[1]!.duration).toBe(1081 / 48000);
		expect(await track.getTimeResolution()).toBe(48000);
		expect(await track.getDurationFromMetadata()).toBe(1128 / 48000);
		expect(await track.computeDuration()).toBe(1128 / 48000);
	});
}
