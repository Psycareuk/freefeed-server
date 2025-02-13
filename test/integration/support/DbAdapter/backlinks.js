/* eslint-env node, mocha */
/* global $pg_database */
import unexpected from 'unexpected';
import unexpectedMap from 'unexpected-map';

import { dbAdapter, Post, User } from '../../../../app/models';
import { GONE_SUSPENDED } from '../../../../app/models/user';
import cleanDB from '../../../dbCleaner';

const expect = unexpected.clone().use(unexpectedMap);

describe('Backlinks DB trait', () => {
  let luna, mars, venus, jupiter;
  let lunaFeed, marsFeed, venusFeed;
  let lunaPost, marsPost, venusPost;
  before(async () => {
    await cleanDB($pg_database);

    luna = new User({ username: 'luna', password: 'pw' });
    mars = new User({ username: 'mars', password: 'pw' });
    venus = new User({ username: 'venus', password: 'pw' });
    jupiter = new User({ username: 'jupiter', password: 'pw' });
    await Promise.all([luna.create(), mars.create(), venus.create(), jupiter.create()]);

    [lunaFeed, marsFeed, venusFeed] = await Promise.all([
      luna.getPostsTimeline(),
      mars.getPostsTimeline(),
      venus.getPostsTimeline(),
    ]);

    // Luna post has 2 backlinks: from the Mars and Venus posts
    // Mars post has 1 backlinks: from the Venus post
    // Venus post has 1 backlinks: from the Jupiter comment to the Mars post

    lunaPost = new Post({
      body: `just a post`,
      userId: luna.id,
      timelineIds: [lunaFeed.id],
    });
    await lunaPost.create();

    marsPost = new Post({
      body: `luna post: example.com/${lunaPost.id}`,
      userId: mars.id,
      timelineIds: [marsFeed.id],
    });
    await marsPost.create();

    venusPost = new Post({
      body: `luna post: example.com/${lunaPost.id}, mars post: example.com/${marsPost.id}`,
      userId: venus.id,
      timelineIds: [venusFeed.id],
    });
    await venusPost.create();

    await jupiter
      .newComment({ postId: marsPost.id, body: `venus post: example.com/${venusPost.id}` })
      .create();
  });

  it(`should calculate backlink counts for Luna, Mars and Venus posts`, async () => {
    const result = await dbAdapter.getBacklinksCounts([lunaPost.id, marsPost.id, venusPost.id]);
    expect(
      result,
      'to equal',
      new Map([
        [lunaPost.id, 2],
        [marsPost.id, 1],
        [venusPost.id, 1],
      ]),
    );
  });

  describe('Venus becomes protected', () => {
    before(() => venus.update({ isProtected: '1', isPrivate: '0' }));
    after(() => venus.update({ isProtected: '0', isPrivate: '0' }));

    it(`should not count Venus post for anonymous`, async () => {
      const result = await dbAdapter.getBacklinksCounts([lunaPost.id, marsPost.id, venusPost.id]);
      expect(
        result,
        'to equal',
        new Map([
          [lunaPost.id, 1],
          [venusPost.id, 1],
        ]),
      );
    });

    it(`should count Venus post for Luna`, async () => {
      const result = await dbAdapter.getBacklinksCounts(
        [lunaPost.id, marsPost.id, venusPost.id],
        luna.id,
      );
      expect(
        result,
        'to equal',
        new Map([
          [lunaPost.id, 2],
          [marsPost.id, 1],
          [venusPost.id, 1],
        ]),
      );
    });
  });

  describe('Venus becomes private', () => {
    before(() => venus.update({ isProtected: '1', isPrivate: '1' }));
    after(() => venus.update({ isProtected: '0', isPrivate: '0' }));

    it(`should not count Venus post for anonymous`, async () => {
      const result = await dbAdapter.getBacklinksCounts([lunaPost.id, marsPost.id, venusPost.id]);
      expect(
        result,
        'to equal',
        new Map([
          [lunaPost.id, 1],
          [venusPost.id, 1],
        ]),
      );
    });

    it(`should not count Venus post for Luna`, async () => {
      const result = await dbAdapter.getBacklinksCounts(
        [lunaPost.id, marsPost.id, venusPost.id],
        luna.id,
      );
      expect(
        result,
        'to equal',
        new Map([
          [lunaPost.id, 1],
          [venusPost.id, 1],
        ]),
      );
    });

    it(`should count Venus post for Venus`, async () => {
      const result = await dbAdapter.getBacklinksCounts(
        [lunaPost.id, marsPost.id, venusPost.id],
        venus.id,
      );
      expect(
        result,
        'to equal',
        new Map([
          [lunaPost.id, 2],
          [marsPost.id, 1],
          [venusPost.id, 1],
        ]),
      );
    });
  });

  describe('Mars bans Jupiter', () => {
    before(() => mars.ban(jupiter.username));
    after(() => mars.unban(jupiter.username));

    it(`should count Jupiter comment for anonymous`, async () => {
      const result = await dbAdapter.getBacklinksCounts([lunaPost.id, marsPost.id, venusPost.id]);
      expect(
        result,
        'to equal',
        new Map([
          [lunaPost.id, 2],
          [marsPost.id, 1],
          [venusPost.id, 1],
        ]),
      );
    });

    it(`should count Jupiter comment for Venus`, async () => {
      const result = await dbAdapter.getBacklinksCounts(
        [lunaPost.id, marsPost.id, venusPost.id],
        venus.id,
      );
      expect(
        result,
        'to equal',
        new Map([
          [lunaPost.id, 2],
          [marsPost.id, 1],
          [venusPost.id, 1],
        ]),
      );
    });

    it(`should not count Jupiter comment for Mars`, async () => {
      const result = await dbAdapter.getBacklinksCounts(
        [lunaPost.id, marsPost.id, venusPost.id],
        mars.id,
      );
      expect(
        result,
        'to equal',
        new Map([
          [lunaPost.id, 2],
          [marsPost.id, 1],
        ]),
      );
    });

    it(`should not count Mars post for Jupiter`, async () => {
      const result = await dbAdapter.getBacklinksCounts(
        [lunaPost.id, marsPost.id, venusPost.id],
        jupiter.id,
      );
      expect(
        result,
        'to equal',
        new Map([
          [lunaPost.id, 1],
          [marsPost.id, 1],
        ]),
      );
    });
  });

  describe('Mars suspends themselves', () => {
    before(() => mars.setGoneStatus(GONE_SUSPENDED));
    after(() => mars.setGoneStatus(null));

    it(`should not count Mars post for anonymous`, async () => {
      const result = await dbAdapter.getBacklinksCounts([lunaPost.id, marsPost.id, venusPost.id]);
      expect(
        result,
        'to equal',
        new Map([
          [lunaPost.id, 1],
          [marsPost.id, 1],
        ]),
      );
    });
  });

  describe('Link to the post itself', () => {
    before(() => lunaPost.update({ body: `this post has address example.com/${lunaPost.id}` }));
    after(() => lunaPost.update({ body: 'just a post' }));

    it(`should not count self-link to the Luna post`, async () => {
      const result = await dbAdapter.getBacklinksCounts([lunaPost.id]);
      expect(result, 'to equal', new Map([[lunaPost.id, 2]]));
    });
  });
});
