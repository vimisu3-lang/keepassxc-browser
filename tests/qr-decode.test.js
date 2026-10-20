import { describe, it, expect } from 'vitest';
import qrcode from 'qrcode-generator';
import { readFileSync } from 'node:fs';
import path from 'node:path';

// jsQR is a vendored UMD bundle (used by the popup as a plain script)
const jsQR = (() => {
    const file = path.join(process.cwd(), 'keepassxc-browser', 'common', 'jsQR.js');
    const source = readFileSync(file, 'utf8');
    return new Function(`${source}; return jsQR;`)();
})();

// Renders a QR code to the RGBA pixel data that jsQR expects
const renderQrCode = function(text, { scale = 6, quietZone = 4, inverted = false } = {}) {
    const qr = qrcode(0, 'M');
    qr.addData(text);
    qr.make();

    const size = qr.getModuleCount();
    const width = (size + quietZone * 2) * scale;
    const rgba = new Uint8ClampedArray(width * width * 4);

    const light = inverted ? 0 : 255;
    const dark = inverted ? 255 : 0;

    for (let i = 0; i < rgba.length; i += 4) {
        rgba[i] = light;
        rgba[i + 1] = light;
        rgba[i + 2] = light;
        rgba[i + 3] = 255;
    }

    for (let row = 0; row < size; row++) {
        for (let col = 0; col < size; col++) {
            if (!qr.isDark(row, col)) {
                continue;
            }

            for (let dy = 0; dy < scale; dy++) {
                for (let dx = 0; dx < scale; dx++) {
                    const px = (quietZone + col) * scale + dx;
                    const py = (quietZone + row) * scale + dy;
                    const idx = (py * width + px) * 4;
                    rgba[idx] = dark;
                    rgba[idx + 1] = dark;
                    rgba[idx + 2] = dark;
                }
            }
        }
    }

    return { imageData: rgba, width, height: width };
};

const decode = (image) =>
    jsQR(image.imageData, image.width, image.height, { inversionAttempts: 'attemptBoth' })?.data || null;

describe('TOTP QR code decoding', () => {
    it('decodes an otpauth URI from a QR code', () => {
        const uri = 'otpauth://totp/Example:alice?secret=JBSWY3DPEHPK3PXP&issuer=Example';
        expect(decode(renderQrCode(uri))).toBe(uri);
    });

    it('decodes a QR code shown on a dark background (inverted)', () => {
        const uri = 'otpauth://totp/Example:alice?secret=JBSWY3DPEHPK3PXP';
        expect(decode(renderQrCode(uri, { inverted: true }))).toBe(uri);
    });

    it('returns null when there is no QR code', () => {
        const width = 120;
        const rgba = new Uint8ClampedArray(width * width * 4).fill(255);
        expect(jsQR(rgba, width, width, { inversionAttempts: 'attemptBoth' })).toBeNull();
    });
});
