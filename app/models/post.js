/* eslint babel/semi: "error" */
import GraphemeBreaker from 'grapheme-breaker';
import _ from 'lodash';
import config from 'config';

import { extractHashtags } from '../support/hashtags';
import { PubSub as pubSub } from '../models';
import { getRoomsOfPost } from '../pubsub-listener';
import { EventService } from '../support/EventService';
import { List } from '../support/open-lists';
import { getUpdatedUUIDs, notifyBacklinkedLater, notifyBacklinkedNow } from '../support/backlinks';

import {
  HOMEFEED_MODE_FRIENDS_ONLY,
  HOMEFEED_MODE_CLASSIC,
  HOMEFEED_MODE_FRIENDS_ALL_ACTIVITY,
} from './timeline';

/**
 * @typedef { import("../models").User } User
 * @typedef { import("../models").Timeline } Timeline
 */

export function addModel(dbAdapter) {
  class Post {
    id;
    attachments;
    userId;
    timelineIds;
    currentUser;
    commentsDisabled;
    feedIntIds;
    /** @type {number[]} */
    destinationFeedIds;
    commentsCount;
    likesCount;
    isPrivate;
    isProtected;
    isPropagable;

    constructor(params) {
      this.id = params.id;
      this.body = params.body;
      this.attachments = params.attachments || [];
      this.userId = params.userId;
      this.timelineIds = params.timelineIds;
      this.currentUser = params.currentUser;
      this.commentsDisabled = params.commentsDisabled;
      this.feedIntIds = params.feedIntIds || [];
      this.destinationFeedIds = params.destinationFeedIds || [];
      this.commentsCount = params.commentsCount;
      this.likesCount = params.likesCount;
      this.isPrivate = params.isPrivate || '0';
      this.isProtected = params.isProtected || '0';
      this.isPropagable = params.isPropagable || '0';

      if (params.friendfeedUrl) {
        this.friendfeedUrl = params.friendfeedUrl;
      }

      if (parseInt(params.createdAt, 10)) {
        this.createdAt = params.createdAt;
      }

      if (parseInt(params.updatedAt, 10)) {
        this.updatedAt = params.updatedAt;
      }

      if (parseInt(params.bumpedAt, 10)) {
        this.bumpedAt = params.bumpedAt;
      }

      if (params.maxComments != 'all') {
        this.maxComments = parseInt(params.maxComments, 10) || 2;
      } else {
        this.maxComments = params.maxComments;
      }

      if (params.maxLikes !== 'all') {
        this.maxLikes = parseInt(params.maxLikes, 10) || 3;
      } else {
        this.maxLikes = params.maxLikes;
      }
    }

    get body() {
      return this.body_;
    }

    set body(newValue) {
      if (!newValue) {
        this.body_ = '';
        return;
      }

      this.body_ = newValue.trim();
    }

    validate(newAttachments = this.attachments) {
      if (!this.userId) {
        throw new Error('Post author is required');
      }

      if (this.body.length === 0 && newAttachments.length === 0) {
        throw new Error('Post body must not be empty (without attachments)');
      }

      if (GraphemeBreaker.countBreaks(this.body) > config.maxLength.post) {
        throw new Error(`Maximum post length is ${config.maxLength.post} graphemes`);
      }
    }

    async create() {
      this.validate();

      const payload = {
        body: this.body,
        userId: this.userId,
        commentsDisabled: this.commentsDisabled,
      };
      const [destFeeds, author] = await Promise.all([
        dbAdapter.getTimelinesByIds(this.timelineIds),
        dbAdapter.getUserById(this.userId),
      ]);
      this.feedIntIds = destFeeds.map((f) => f.intId);
      this.destinationFeedIds = this.feedIntIds.slice();

      // save post to the database
      this.id = await dbAdapter.createPost(payload, this.feedIntIds);

      const newPost = await dbAdapter.getPostById(this.id);
      const fieldsToUpdate = [
        'isPrivate',
        'isProtected',
        'isPropagable',
        'createdAt',
        'updatedAt',
        'bumpedAt',
      ];

      for (const f of fieldsToUpdate) {
        this[f] = newPost[f];
      }

      await Promise.all([this.linkAttachments(), this.processHashtagsOnCreate()]);

      const rtUpdates = destFeeds
        .filter((f) => f.isDirects())
        .map((f) => pubSub.updateUnreadDirects(f.userId));
      rtUpdates.push(pubSub.newPost(this.id));

      await EventService.onPostCreated(
        newPost,
        destFeeds.map((f) => f.id),
        author,
      );

      await Promise.all([
        ...rtUpdates,
        dbAdapter.setUpdatedAtInGroupsByIds(destFeeds.map((f) => f.userId)),
        dbAdapter.statsPostCreated(this.userId),
        notifyBacklinkedNow(this, pubSub, getUpdatedUUIDs(this.body)),
      ]);

      await pubSub.updateGroupTimes(destFeeds.map((f) => f.userId));

      return this;
    }

    /**
     * Update Post object
     * This method updates only properties that are listen in params
     *
     * @param {{body?: string, attachments?: UUID[], destinationFeedIds?: UUID[]}} params
     * @returns {Promise<Post>}
     */
    async update(params) {
      const editableProperties = ['body', 'attachments', 'destinationFeedIds'];

      // It is important to use "!= null" here and below because
      // params[p] can exists but have a null or undefined value.
      if (!editableProperties.some((p) => params[p] != null)) {
        // Nothing changed
        return this;
      }

      this.updatedAt = new Date().getTime();
      const payload = { updatedAt: this.updatedAt.toString() };
      const afterUpdate = [];

      let realtimeRooms = await getRoomsOfPost(this);
      const usersCanSeePostBeforeIds = await this.usersCanSee();

      if (params.body != null) {
        const prevBody = this.body;
        this.body = params.body;
        payload.body = this.body;

        // Update post hashtags
        afterUpdate.push(() => this.processHashtagsOnUpdate());
        // Notify mentioned posts
        afterUpdate.push(
          await notifyBacklinkedLater(this, pubSub, getUpdatedUUIDs(this.body, prevBody)),
        );
      }

      let newAttachments = undefined;

      if (params.attachments != null) {
        // Calculate changes in attachments
        const oldAttachments = (await this.getAttachmentIds()) || [];
        newAttachments = params.attachments || [];
        const removedAttachments = _.difference(oldAttachments, newAttachments);

        // Update post attachments in DB
        afterUpdate.push(() => this.linkAttachments(newAttachments));
        afterUpdate.push(() => this.unlinkAttachments(removedAttachments));
      }

      if (params.destinationFeedIds != null) {
        const removedFeedIds = _.difference(this.destinationFeedIds, params.destinationFeedIds);
        const addedFeedIds = _.difference(params.destinationFeedIds, this.destinationFeedIds);

        if (removedFeedIds.length > 0 || addedFeedIds.length > 0) {
          this.destinationFeedIds = params.destinationFeedIds;
          this.feedIntIds = _.union(this.feedIntIds, this.destinationFeedIds);
          this.feedIntIds = _.difference(this.feedIntIds, removedFeedIds);

          payload.destinationFeedIds = this.destinationFeedIds;
          payload.feedIntIds = this.feedIntIds;

          {
            const [postAuthor, removedFeeds, addedFeeds] = await Promise.all([
              this.getCreatedBy(),
              dbAdapter.getTimelinesByIntIds(removedFeedIds),
              dbAdapter.getTimelinesByIntIds(addedFeedIds),
            ]);
            afterUpdate.push(() =>
              EventService.onPostFeedsChanged(this, params.updatedBy || postAuthor, {
                addedFeeds,
                removedFeeds,
              }),
            );
          }

          // Publishing changes to the old AND new realtime rooms
          afterUpdate.push(async () => {
            const rooms = await getRoomsOfPost(this);
            realtimeRooms = _.union(realtimeRooms, rooms);
          });
        }
      }

      afterUpdate.push(async () => {
        await EventService.onPostCreated(
          this,
          await dbAdapter.getTimelinesUUIDsByIntIds(this.destinationFeedIds),
          await this.getCreatedBy(),
        );
      });

      this.validate(newAttachments);

      // Update post in DB
      await dbAdapter.updatePost(this.id, payload);

      // Perform afterUpdate actions
      await Promise.all(afterUpdate.map((f) => f()));

      // Finally, publish changes
      await pubSub.updatePost(this.id, {
        rooms: realtimeRooms,
        usersBeforeIds: usersCanSeePostBeforeIds,
      });

      return this;
    }

    async setCommentsDisabled(newValue) {
      // Reflect post changes
      this.commentsDisabled = newValue;

      // Update post body in DB
      const payload = { commentsDisabled: this.commentsDisabled };
      await dbAdapter.updatePost(this.id, payload);

      // Finally, publish changes
      await pubSub.updatePost(this.id);

      return this;
    }

    async destroy(destroyedBy = null) {
      const [realtimeRooms, comments, groups, notifyBacklinked] = await Promise.all([
        getRoomsOfPost(this),
        this.getComments(),
        this.getGroupsPostedTo(),
        notifyBacklinkedLater(this, pubSub, getUpdatedUUIDs(this.body)),
        // Does't return anything
        // It should be executed while post data is still in the DB
        dbAdapter.statsPostDeleted(this.userId, this.id),
      ]);

      // remove all comments
      await Promise.all(comments.map((comment) => comment.destroy()));

      await dbAdapter.withdrawPostFromFeeds(this.feedIntIds, this.id);
      await dbAdapter.deletePost(this.id);

      await Promise.all([
        pubSub.destroyPost(this.id, realtimeRooms),
        destroyedBy ? EventService.onPostDestroyed(this, destroyedBy, { groups }) : null,
        notifyBacklinked(),
      ]);
    }

    getCreatedBy() {
      return dbAdapter.getUserById(this.userId);
    }

    async getSubscribedTimelineIds(groupOnly) {
      if (typeof groupOnly === 'undefined') {
        groupOnly = false;
      }

      const feed = await dbAdapter.getFeedOwnerById(this.userId);

      const feeds = [feed.getRiverOfNewsTimelineId()];

      if (!groupOnly) {
        feeds.push(feed.getPostsTimelineId());
      }

      let timelineIds = await Promise.all(feeds);
      const newTimelineIds = await this.getTimelineIds();

      timelineIds = timelineIds.concat(newTimelineIds);
      return _.uniq(timelineIds);
    }

    async getSubscribedTimelines() {
      const timelineIds = await this.getSubscribedTimelineIds();
      this.subscribedTimelines = await dbAdapter.getTimelinesByIds(timelineIds);

      return this.subscribedTimelines;
    }

    async getTimelineIds() {
      const timelineIds = await dbAdapter.getPostUsagesInTimelines(this.id);
      this.timelineIds = timelineIds || [];
      return this.timelineIds;
    }

    /**
     * @return {Promise<Timeline[]>}
     */
    async getTimelines() {
      this.timelines = await dbAdapter.getTimelinesByIntIds(this.feedIntIds);

      return this.timelines;
    }

    async getPostedToIds() {
      const timelineIds = await dbAdapter.getTimelinesUUIDsByIntIds(this.destinationFeedIds);
      this.timelineIds = timelineIds || [];
      return this.timelineIds;
    }

    async getPostedTo() {
      this.postedTo = await dbAdapter.getTimelinesByIntIds(this.destinationFeedIds);

      return this.postedTo;
    }

    /**
     * Return all groups post posted to or empty array
     *
     * @returns {Array.<User>}
     */
    async getGroupsPostedTo() {
      return await dbAdapter.getPostGroups(this.id);
    }

    /**
     * Returns all RiverOfNews timelines this post belongs to. Timelines are
     * calculated dynamically.
     *
     * If post have author U, destination feeds owned by D's and activity feeds
     * owned by A's then it belongs to the union of the following RiverOfNewses:
     *
     *  - Timelines subscribed to D
     *  - Timelines subscribed to U if mode is
     *    HOMEFEED_MODE_FRIENDS_ALL_ACTIVITY
     *  - Timelines subscribed to A if mode is HOMEFEED_MODE_CLASSIC and post is
     *    propagable or mode is HOMEFEED_MODE_FRIENDS_ALL_ACTIVITY
     *
     * The latest two timelines groups (U- and A-subscribed) are additionally
     * filtered by its hide lists: if timeline's hide list intersects with D,
     * then this timeline excludes from the result set.
     *
     * @param {string} [mode] one of HOMEFEED_MODE_* constants
     * @return {Timeline[]}
     */
    async getRiverOfNewsTimelines(mode = HOMEFEED_MODE_CLASSIC) {
      const postFeeds = await this.getTimelines();
      const destinationsFeedsOwners = postFeeds
        .filter((f) => f.isPosts() || f.isDirects())
        .map((f) => f.userId);
      const activityFeedsOwners = postFeeds
        .filter((f) => f.isLikes() || f.isComments())
        .map((f) => f.userId);

      let feedIds = await dbAdapter.getHomeFeedSubscribedToUsers(destinationsFeedsOwners);

      const addWithHideList = async (feedOwners) => {
        let addFeedIds = await dbAdapter.getHomeFeedSubscribedToUsers(feedOwners);
        addFeedIds = _.difference(addFeedIds, feedIds);

        if (addFeedIds.length > 0) {
          const hideLists = await dbAdapter.getHomeFeedsHideLists(addFeedIds);
          addFeedIds = Object.keys(hideLists).filter(
            (k) => _.intersection(hideLists[k], destinationsFeedsOwners).length === 0,
          );
          feedIds = _.union(feedIds, addFeedIds);
        }
      };

      // This post can propagate via activity feeds
      if (
        mode === HOMEFEED_MODE_FRIENDS_ALL_ACTIVITY ||
        (mode === HOMEFEED_MODE_CLASSIC && this.isPropagable === '1')
      ) {
        await addWithHideList(activityFeedsOwners);
      }

      // This post can propagate via post author
      if (mode === HOMEFEED_MODE_FRIENDS_ALL_ACTIVITY) {
        await addWithHideList([this.userId]);
      }

      return await dbAdapter.getTimelinesByIds(feedIds);
    }

    /**
     * Same as getRiverOfNewsTimelines but returns the { [mode]: Timeline[] } hash
     *
     * @return {Object.<string, Timeline[]>}
     */
    async getRiverOfNewsTimelinesByModes() {
      const keys = [
        HOMEFEED_MODE_FRIENDS_ONLY,
        HOMEFEED_MODE_CLASSIC,
        HOMEFEED_MODE_FRIENDS_ALL_ACTIVITY,
      ];
      const values = await Promise.all(keys.map((k) => this.getRiverOfNewsTimelines(k)));
      return _.zipObject(keys, values);
    }

    /**
     * Returns all MyDiscussions timelines this post belongs to.
     * Timelines are calculated dynamically.
     *
     * @return {Timeline[]}
     */
    async getMyDiscussionsTimelines() {
      const postFeeds = await this.getTimelines();
      const activities = postFeeds.filter((f) => f.isLikes() || f.isComments());

      /**
       * 'MyDiscussions' feeds of post author and users who did
       * some activity (likes, comments) on post.
       */
      const myDiscussionsOwnerIds = activities.map((f) => f.userId);
      myDiscussionsOwnerIds.push(this.userId);
      return await dbAdapter.getUsersNamedTimelines(_.uniq(myDiscussionsOwnerIds), 'MyDiscussions');
    }

    async getGenericFriendOfFriendTimelineIntIds(user, type) {
      const timelineIntIds = [];

      const userTimelineIntId = await user[`get${type}TimelineIntId`]();
      timelineIntIds.push(userTimelineIntId);

      const timelines = await dbAdapter.getTimelinesByIntIds(this.destinationFeedIds);
      const timelineOwners = await dbAdapter.getFeedOwnersByIds(timelines.map((tl) => tl.userId));

      // Adds the specified post to River of News if and only if
      // that post has been published to user's Post timeline,
      // otherwise this post will stay in group(s) timelines
      let groupOnly = true;

      if (_.some(timelineOwners.map((owner) => owner.isUser()))) {
        groupOnly = false;

        const timeline = await dbAdapter.getTimelineByIntId(userTimelineIntId);
        const subscribersIds = await timeline.getSubscriberIds();
        const subscribersRiversOfNewsIntIds = await dbAdapter.getUsersNamedFeedsIntIds(
          subscribersIds,
          ['RiverOfNews'],
        );
        timelineIntIds.push(subscribersRiversOfNewsIntIds);
      }

      const postAuthor = await dbAdapter.getFeedOwnerById(this.userId);
      timelineIntIds.push(await postAuthor.getRiverOfNewsTimelineIntId());

      if (!groupOnly) {
        timelineIntIds.push(await postAuthor.getPostsTimelineIntId());
      }

      timelineIntIds.push(await user.getRiverOfNewsTimelineIntId());
      timelineIntIds.push(this.feedIntIds);

      return _.uniq(_.flatten(timelineIntIds));
    }

    getLikesFriendOfFriendTimelineIntIds(user) {
      return this.getGenericFriendOfFriendTimelineIntIds(user, 'Likes');
    }

    getCommentsFriendOfFriendTimelineIntIds(user) {
      return this.getGenericFriendOfFriendTimelineIntIds(user, 'Comments');
    }

    async hide(userId) {
      const theUser = await dbAdapter.getUserById(userId);
      const hidesTimelineId = await theUser.getHidesTimelineIntId();

      await dbAdapter.insertPostIntoFeeds([hidesTimelineId], this.id);

      await pubSub.hidePost(theUser.id, this.id);
    }

    async unhide(userId) {
      const theUser = await dbAdapter.getUserById(userId);
      const hidesTimelineId = await theUser.getHidesTimelineIntId();

      await dbAdapter.withdrawPostFromFeeds([hidesTimelineId], this.id);

      await pubSub.unhidePost(theUser.id, this.id);
    }

    async save(userId) {
      const theUser = await dbAdapter.getUserById(userId);
      const savesTimelineId = await theUser.getSavesTimelineIntId();

      await dbAdapter.insertPostIntoFeeds([savesTimelineId], this.id);

      await pubSub.savePost(theUser.id, this.id);
    }

    async unsave(userId) {
      const theUser = await dbAdapter.getUserById(userId);
      const savesTimelineId = await theUser.getSavesTimelineIntId();

      await dbAdapter.withdrawPostFromFeeds([savesTimelineId], this.id);

      await pubSub.unsavePost(theUser.id, this.id);
    }

    async addComment(comment) {
      const user = await dbAdapter.getUserById(comment.userId);

      let timelineIntIds = this.destinationFeedIds.slice();

      // only subscribers are allowed to read direct posts
      if (!(await this.isStrictlyDirect())) {
        const moreTimelineIntIds = await this.getCommentsFriendOfFriendTimelineIntIds(user);
        timelineIntIds.push(...moreTimelineIntIds);

        timelineIntIds = _.uniq(timelineIntIds);
      }

      let timelines = await dbAdapter.getTimelinesByIntIds(timelineIntIds);

      // no need to post updates to rivers of banned users
      const bannedIds = await user.getBanIds();
      timelines = timelines.filter((timeline) => !(timeline.userId in bannedIds));

      await this.publishChangesToFeeds(timelines, false);

      return timelines;
    }

    async publishChangesToFeeds(timelines, isLikeAction = false) {
      const feedsIntIds = timelines.map((t) => t.intId);
      const insertIntoFeedIds = _.difference(feedsIntIds, this.feedIntIds);
      const timelineOwnersIds = timelines.map((t) => t.userId);

      if (insertIntoFeedIds.length > 0) {
        await dbAdapter.insertPostIntoFeeds(insertIntoFeedIds, this.id);
      }

      if (isLikeAction) {
        return;
      }

      const now = new Date();

      const promises = [
        dbAdapter.setPostBumpedAt(this.id, now.getTime()),
        dbAdapter.setUpdatedAtInGroupsByIds(timelineOwnersIds, now.getTime()),
      ];

      await Promise.all(promises);

      await pubSub.updateGroupTimes(timelineOwnersIds);
    }

    getComments() {
      return dbAdapter.getPostComments(this.id);
    }

    async linkAttachments(attachmentList) {
      const attachmentIds = attachmentList || this.attachments || [];
      const attachments = await dbAdapter.getAttachmentsByIds(attachmentIds);

      const attachmentPromises = attachments
        .filter((attachment) => {
          // Filter out invalid attachments
          return attachment.fileSize !== undefined;
        })
        .map((attachment, ord) => {
          if (this.attachments) {
            const pos = this.attachments.indexOf(attachment.id);

            if (pos === -1) {
              this.attachments.push(attachment);
            } else {
              this.attachments[pos] = attachment;
            }
          }

          // Update connections in DB

          return dbAdapter.linkAttachmentToPost(attachment.id, this.id, ord);
        });

      await Promise.all(attachmentPromises);
    }

    async unlinkAttachments(attachmentList) {
      const attachmentIds = attachmentList || [];
      const attachments = await dbAdapter.getAttachmentsByIds(attachmentIds);

      const attachmentPromises = attachments.map((attachment) => {
        // should we modify `this.attachments` here?

        // Update connections in DB
        return dbAdapter.unlinkAttachmentFromPost(attachment.id, this.id);
      });

      await Promise.all(attachmentPromises);
    }

    async getAttachmentIds() {
      this.attachmentIds = await dbAdapter.getPostAttachments(this.id);
      return this.attachmentIds;
    }

    async getAttachments() {
      this.attachments = await dbAdapter.getAttachmentsOfPost(this.id);

      return this.attachments;
    }

    async getLikeIds() {
      const omittedLikesCount = await this.getOmittedLikes();
      let likedUsersIds = await dbAdapter.getPostLikersIdsWithoutBannedUsers(
        this.id,
        this.currentUser,
      );

      likedUsersIds = likedUsersIds.sort((a, b) => {
        if (a == this.currentUser) {
          return -1;
        }

        if (b == this.currentUser) {
          return 1;
        }

        return 0;
      });
      likedUsersIds.splice(likedUsersIds.length - omittedLikesCount, omittedLikesCount);
      return likedUsersIds;
    }

    async getOmittedLikes() {
      let length = this.likesCount;

      if (length == null) {
        length = await dbAdapter.getPostLikesCount(this.id);
      }

      if (this.maxLikes !== 'all') {
        const threshold = this.maxLikes + 1;

        if (length > threshold) {
          return length - this.maxLikes;
        }
      }

      return 0;
    }

    async getLikes() {
      const userIds = await this.getLikeIds();

      const users = await dbAdapter.getUsersByIds(userIds);

      // filter non-existant likers
      this.likes = users.filter(Boolean);

      return this.likes;
    }

    async isStrictlyDirect() {
      const timelines = await this.getPostedTo();
      const flags = timelines.map((timeline) => timeline.isDirects());

      // one non-direct timeline is enough
      return _.every(flags);
    }

    /**
     * Adds like to post. This method does not performs any access check.
     * It returns true on success and false if this post was already
     * liked by this user.
     *
     * @param {User} user
     * @returns {boolean}
     */
    async addLike(user) {
      const success = await dbAdapter.likePost(this.id, user.id);

      if (!success) {
        return false;
      }

      const [likesTimeline, ,] = await Promise.all([
        user.getLikesTimeline(),
        dbAdapter.statsLikeCreated(user.id),
      ]);

      // Local bumps
      // We bump post in the widest homefeed mode (HOMEFEED_MODE_FRIENDS_ALL_ACTIVITY)
      {
        const prevRONs = await this.getRiverOfNewsTimelines(HOMEFEED_MODE_FRIENDS_ALL_ACTIVITY);
        const prevRONsOwners = _.map(prevRONs, 'userId');
        const usersSubscribedToLikeFeed = await dbAdapter.getUsersSubscribedToTimelines([
          likesTimeline.id,
        ]);
        usersSubscribedToLikeFeed.push(user.id); // user always implicitly subscribed to their feeds
        const newRONsOwners = _.difference(usersSubscribedToLikeFeed, prevRONsOwners);
        await dbAdapter.setLocalBumpForUsers(this.id, newRONsOwners);
      }

      await dbAdapter.insertPostIntoFeeds([likesTimeline.intId], this.id);

      // Send realtime notifications
      await pubSub.newLike(this, user.id);

      return true;
    }

    /**
     * Removes like from post. This method does not performs any access check.
     * It returns true on success and false if this post was not already
     * liked by this user.
     *
     * @param {User} user
     * @returns {boolean}
     */
    async removeLike(user) {
      const success = await dbAdapter.unlikePost(this.id, user.id);

      if (!success) {
        return false;
      }

      const [realtimeRooms, timelineId, ,] = await Promise.all([
        getRoomsOfPost(this),
        user.getLikesTimelineIntId(),
        dbAdapter.statsLikeDeleted(user.id),
      ]);
      await dbAdapter.withdrawPostFromFeeds([timelineId], this.id);

      // Send realtime notifications
      await pubSub.removeLike(this.id, user.id, realtimeRooms);

      return true;
    }

    async isBannedFor(userId) {
      const user = await dbAdapter.getUserById(userId);
      const banIds = await user.getBanIds();

      return banIds.includes(this.userId);
    }

    async isHiddenIn(timeline) {
      // hides are applicable only to river
      if (!(timeline.isRiverOfNews() || timeline.isHides())) {
        return false;
      }

      const owner = await timeline.getUser();
      const hidesTimelineIntId = await owner.getHidesTimelineIntId();

      return dbAdapter.isPostPresentInTimeline(hidesTimelineIntId, this.id);
    }

    /**
     * isVisibleFor checks visibility of the post for the given viewer
     * or for anonymous if viewer is null.
     *
     *  Viewer CAN NOT see post if:
     * - viwer is anonymous and post is not public or
     * - viewer is authorized and
     *   - post author banned viewer or was banned by viewer or
     *   - post is private and viewer cannot read any of post's destination feeds
     *
     * @param {User|null} viewer
     * @returns {boolean}
     */
    async isVisibleFor(viewer) {
      const author = await dbAdapter.getUserById(this.userId);

      if (!author.isActive) {
        return false;
      }

      // Check if viewer is anonymous and post is not public
      if (!viewer) {
        return this.isProtected === '0';
      }

      // Check if post author banned viewer or was banned by viewer
      const bannedUserIds = await dbAdapter.getUsersBansOrWasBannedBy(viewer.id);

      if (bannedUserIds.includes(this.userId)) {
        return false;
      }

      // Check if post is private and viewer cannot read any of post's destination feeds
      if (this.isPrivate === '1') {
        const privateFeedIds = await dbAdapter.getVisiblePrivateFeedIntIds(viewer.id);

        if (_.isEmpty(_.intersection(this.destinationFeedIds, privateFeedIds))) {
          return false;
        }
      }

      return true;
    }

    /**
     * Filter users that can not see this post
     *
     * Viewer CAN NOT see post if:
     * - viwer is anonymous and post is not public or
     * - viewer is authorized and
     *   - post author banned viewer or was banned by viewer or
     *   - post is private and viewer cannot read any of post's destination feeds
     *
     * @param {User[]} users
     * @returns {User[]}
     */
    async onlyUsersCanSeePost(users) {
      if (users.length === 0) {
        return [];
      }

      const allowedIds = await this.usersCanSee();
      return users.filter(({ id }) => allowedIds.includes(id));
    }

    /**
     * Returns ids of all users who can see this post.
     * Ids are returned as (possible open) list defined in support/open-lists.js
     *
     * @returns {Promise<List>}
     */
    async usersCanSee() {
      const bannedIds = await dbAdapter.getUsersBansOrWasBannedBy(this.userId);
      const allExceptBanned = new List(bannedIds, false);

      if (this.isPrivate === '0') {
        return allExceptBanned;
      }

      const allowedIds = await dbAdapter.getUsersWhoCanSeePrivateFeeds(this.destinationFeedIds);
      return List.intersection(allowedIds, allExceptBanned);
    }

    async processHashtagsOnCreate() {
      const postTags = _.uniq(extractHashtags(this.body.toLowerCase()));

      if (!postTags || postTags.length == 0) {
        return;
      }

      await dbAdapter.linkPostHashtagsByNames(postTags, this.id);
    }

    async processHashtagsOnUpdate() {
      const linkedPostHashtags = await dbAdapter.getPostHashtags(this.id);

      const presentTags = _.sortBy(linkedPostHashtags.map((t) => t.name));
      const newTags = _.sortBy(_.uniq(extractHashtags(this.body.toLowerCase())));
      const notChangedTags = _.intersection(presentTags, newTags);
      const tagsToUnlink = _.difference(presentTags, notChangedTags);
      const tagsToLink = _.difference(newTags, notChangedTags);

      if (presentTags != newTags) {
        if (tagsToUnlink.length > 0) {
          await dbAdapter.unlinkPostHashtagsByNames(tagsToUnlink, this.id);
        }

        if (tagsToLink.length > 0) {
          await dbAdapter.linkPostHashtagsByNames(tagsToLink, this.id);
        }
      }
    }

    /**
     * Returns true if user is the post author or one of group(s)
     * admins if post was posted to group(s).
     *
     * @param {User} user
     * @returns {boolean}
     */
    async isAuthorOrGroupAdmin(user) {
      if (this.userId === user.id) {
        return true;
      }

      const admins = await dbAdapter.getAdminsOfPostGroups(this.id);
      return admins.some((a) => a.id === user.id);
    }

    /**
     * Removes the direct post recipient. Returns false (and not removes) if the
     * user is a post author or not a direct recipient.
     *
     * @param {User} user
     * @returns {Promise<boolean>}
     */
    async removeDirectRecipient(user) {
      if (this.userId === user.id) {
        return false;
      }

      const userDirectsFeed = await user.getDirectsTimeline();

      const ok = await dbAdapter.withdrawPostFromDestFeed(userDirectsFeed?.intId, this.id);

      if (!ok) {
        return false;
      }

      // TODO Sent RT and notifications

      return true;
    }
  }

  return Post;
}
