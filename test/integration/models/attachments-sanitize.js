/* eslint-env node, mocha */
/* global $pg_database */
import { join } from 'path';
import { promises as fsPromises } from 'fs';
import { createHash } from 'crypto';

import { exiftool } from 'exiftool-vendored';
import expect from 'unexpected';

import { User } from '../../../app/models';
import cleanDB from '../../dbCleaner';
import { SANITIZE_NONE, SANITIZE_VERSION } from '../../../app/support/sanitize-media';

import { createAttachment } from './attachment-helpers';

const photoWithGPSPath = join(__dirname, '../../fixtures/photo-with-gps.jpg');
const photoWithoutGPSPath = join(__dirname, '../../fixtures/photo-without-gps.jpg');

const gpsTags = ['GPSLatitude', 'GPSLongitude', 'GPSPosition', 'GPSLatitudeRef', 'GPSLongitudeRef'];

describe('Sanitize media metadata', () => {
  before(() => cleanDB($pg_database));

  let luna;
  before(async () => {
    luna = new User({ username: 'luna', password: 'pw' });
    await luna.create();
  });

  it('should sanitize attachment metadata', async () => {
    const oldTags = await exiftool.read(photoWithGPSPath);
    expect(oldTags, 'to have keys', gpsTags);

    const att = await createAttachment(luna.id, {
      name: `photo.jpg`,
      type: 'image/jpeg',
      content: await fsPromises.readFile(photoWithGPSPath),
    });

    const newTags = await exiftool.read(att.getPath());
    expect(newTags, 'to not have keys', gpsTags);
    expect(att.sanitized, 'to be', SANITIZE_VERSION);
  });

  it('should not alter file without sensitive metadata', async () => {
    const content = await fsPromises.readFile(photoWithoutGPSPath);
    const oldHash = fileHash(content);

    const att = await createAttachment(luna.id, {
      name: `photo.jpg`,
      type: 'image/jpeg',
      content,
    });

    const newContent = await fsPromises.readFile(att.getPath());
    const newHash = fileHash(newContent);
    expect(newHash, 'to equal', oldHash);
    expect(att.sanitized, 'to be', SANITIZE_VERSION);
  });

  describe(`Luna doesn't want to sanitize her files`, () => {
    before(() => luna.update({ preferences: { sanitizeMediaMetadata: false } }));
    after(() => luna.update({ preferences: { sanitizeMediaMetadata: true } }));

    it('should not alter file with sensitive metadata', async () => {
      const content = await fsPromises.readFile(photoWithGPSPath);
      const oldHash = fileHash(content);

      const att = await createAttachment(luna.id, {
        name: `photo.jpg`,
        type: 'image/jpeg',
        content,
      });

      const newContent = await fsPromises.readFile(att.getPath());
      const newHash = fileHash(newContent);
      expect(newHash, 'to equal', oldHash);
      expect(att.sanitized, 'to be', SANITIZE_NONE);
    });
  });
});

function fileHash(content) {
  return createHash('sha256').update(content).digest('hex');
}
