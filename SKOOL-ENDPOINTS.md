# Skool api2 endpoint inventory

**340 endpoints**, extracted from Skool's own web client on 2026-09-09
(buildId `1788908437685`, chunk `_app-93366f501d9cceed.js`). Regenerate with `node scripts/extract-endpoints.mjs`.

Skool has no public API and no documentation, so its front end is the authority on what `api2.skool.com`
offers. This is that list, so the answer to "does Skool have an endpoint for X" is a lookup rather than a
guess — which is the failure mode `skool_raw_get` exists to prevent.

✅ marks the rows `src/skool.ts` already calls, matched on method **and** path. The analytics rows were marked by
hand on 2026-10-10/11; the classroom routes `src/skool.ts` has called since 2026-09-23 (`POST /courses`, `PUT /courses/{id}`,
`PUT /courses/{id}/state`, `POST /video-meta`) are not yet marked — re-run the script below to refresh every mark.

**Read this as a floor, not a ceiling.** It is what Skool's web client happens to call, not everything api2
accepts — we already rely on `GET /posts/{id}`, which appears nowhere in it (Skool's own client reads a post via `GET /groups/{name}/post-detail` instead). Absence from this
table is a reason to test, not proof of nothing there.

Not included: the Next.js data routes (`/_next/data/{buildId}/…`), which are a separate surface backing the
feed, members, calendar, search, leaderboard and classroom pages — see `src/skool.ts` for those.

An endpoint being listed here says nothing about whether it *should* be wired up. See NOTES.md's
"Admin endpoints deliberately not implemented" for the ones left out on purpose. The list is exhaustive
because it is mechanically extracted, so it also contains credential, billing and destructive routes
(`/auth/*`, `/billing/*`, group and account deletion). Those are inventory, not a menu — none belong
behind an MCP tool.

### Posts, comments, likes

| | method | endpoint | `apiClient` |
|---|---|---|---|
| ✅ | `POST` | `/posts` | `createPost` |
| ✅ | `DELETE` | `/posts/{id}` | `deletePost` |
| ✅ | `GET` | `/posts/{id}/comments` | `getPostComments` |
|  | `GET` | `/posts/{id}/comments/links/` | `getLinkedPostComments` |
|  | `POST` | `/posts/{id}/disable-comments` | `disablePostComments` |
|  | `POST` | `/posts/{id}/enable-comments` | `enablePostComments` |
|  | `POST` | `/posts/{id}/follow` | `followPost` |
|  | `POST` | `/posts/{id}/move-pinned` | `movePinnedPost` |
|  | `POST` | `/posts/{id}/pin` | `pinPost` |
|  | `POST` | `/posts/{id}/pin-comment` | `pinComment` |
|  | `POST` | `/posts/{id}/pin-module` | `pinPostToModule` |
|  | `POST` | `/posts/{id}/read-comments` | `readComments` |
|  | `POST` | `/posts/{id}/report` | `reportPost` |
|  | `POST` | `/posts/{id}/reset-reports` | `resetReports` |
|  | `POST` | `/posts/{id}/unfollow` | `unfollowPost` |
|  | `POST` | `/posts/{id}/unpin` | `unpinPost` |
|  | `POST` | `/posts/{id}/unpin-comment` | `unpinComment` |
|  | `POST` | `/posts/{id}/unpin-module` | `unpinPostFromModule` |
| ✅ | `POST` | `/posts/{id}/update` | `updatePost` |
|  | `GET` | `/posts/{id}/upvote-users` | `listPostUpvoteUsers` |
| ✅ | `PUT` | `/posts/{id}/vote` | `updatePostVote` |
| ✅ | `GET` | `/posts/{id}/vote-users` | `listPostVoteUsers` |

### Polls

| | method | endpoint | `apiClient` |
|---|---|---|---|
| ✅ | `POST` | `/polls` | `createPoll` |
|  | `DELETE` | `/polls/{id}` | `deletePoll` |
|  | `PUT` | `/polls/{id}` | `updatePoll` |
|  | `POST` | `/polls/{id}/cancel-vote` | `cancelPollVote` |
|  | `POST` | `/polls/{id}/change-vote` | `changePollVote` |
| ✅ | `GET` | `/polls/{id}/option-users` | `getPollVotes` |
|  | `POST` | `/polls/{id}/vote` | `voteOnPoll` |

### Communities (read + admin)

| | method | endpoint | `apiClient` |
|---|---|---|---|
|  | `POST` | `/groups` | `createGroup` |
|  | `DELETE` | `/groups/{id}` | `deleteGroup` |
| ✅ | `GET` | `/groups/{id}` | `readGroup` |
| ✅ | `GET` | `/groups/{id}` | `getGroup` |
|  | `PUT` | `/groups/{id}` | `updateGroup` |
|  | `POST` | `/groups/{id}/accept-dispute` | `acceptDispute` |
|  | `POST` | `/groups/{id}/activate-payment` | `activatePayment` |
|  | `PUT` | `/groups/{id}/active-membership-product` | `setActiveGroupMembershipProduct` |
|  | `POST` | `/groups/{id}/add-billing-manager` | `addBillingManager` |
|  | `POST` | `/groups/{id}/add-landing-page-attachment` | `addLandingPageAttachment` |
|  | `POST` | `/groups/{id}/add-survey-question` | `addSurveyQuestion` |
| ✅ | `GET` | `/groups/{id}/admin-metrics` | `getGroupAdminMetrics` |
|  | `GET` | `/groups/{id}/admins` | `readGroupAdmins` |
| ✅ | `GET` | `/groups/{id}/analytics-growth-overview-v2` | `readGroupAnalyticsGrowthOverview` |
| ✅ | `GET` | `/groups/{id}/analytics-overview-v2` | `readGroupAnalyticsOverview` |
| ✅ | `GET` | `/groups/{id}/analytics-v2` | `readGroupAnalytics` |
|  | `POST` | `/groups/{id}/api-keys/rotate` | `rotateApiKey` |
|  | `GET` | `/groups/{id}/auto-affiliate` | `getGroupAutoAffiliateData` |
|  | `GET` | `/groups/{id}/auto-dm ` | `getAutoDmSettings` |
|  | `GET` | `/groups/{id}/billing-connect-link` | `getBillingConnectLink` |
|  | `GET` | `/groups/{id}/billing-payout-data` | `getBillingPayouts` |
|  | `GET` | `/groups/{id}/billing-subscription-data` | `getGroupSubscription` |
|  | `GET` | `/groups/{id}/bulk-action` | `getBulkActionProgress` |
|  | `POST` | `/groups/{id}/bulk-invite` | `addBulkGroupMembers` |
|  | `POST` | `/groups/{id}/cancel-billing-subscription` | `cancelGroupSubscription` |
|  | `POST` | `/groups/{id}/cancel-join` | `cancelJoinGroup` |
|  | `POST` | `/groups/{id}/cancel-join-group-paid ` | `cancelJoinGroupPaid` |
|  | `POST` | `/groups/{id}/cancel-member-billing-subscription` | `cancelMemberSubscription` |
|  | `DELETE` | `/groups/{id}/cards` | `deleteGroupCard` |
|  | `POST` | `/groups/{id}/change-owner` | `changeGroupOwner` |
|  | `GET` | `/groups/{id}/check-handle` | `checkGroupHandle` |
|  | `GET` | `/groups/{id}/connect-account` | `getConnectAccount` |
|  | `POST` | `/groups/{id}/connect-google-ads` | `connectGoogleAds` |
|  | `POST` | `/groups/{id}/connect-hyros` | `connectHyros` |
|  | `POST` | `/groups/{id}/connect-meta-conversions` | `connectMetaPixel` |
|  | `POST` | `/groups/{id}/count-pending-invites` | `countGroupPendingInvites` |
|  | `POST` | `/groups/{id}/counter-dispute` | `counterDispute` |
|  | `GET` | `/groups/{id}/course-names` | `getCourseNames` |
|  | `POST` | `/groups/{id}/delete-billing-subscription` | `deleteGroupSubscription` |
|  | `DELETE` | `/groups/{id}/delete-survey-question` | `deleteSurveyQuestion` |
|  | `POST` | `/groups/{id}/delete-user-recent-posts` | `deleteUserRecentPosts` |
|  | `POST` | `/groups/{id}/disable-auto-dm` | `disableAutoDm` |
|  | `POST` | `/groups/{id}/disable-google-ads` | `disableGoogleAds` |
|  | `POST` | `/groups/{id}/disable-growth-boost` | `disableGrowthBoost` |
|  | `POST` | `/groups/{id}/disable-hyros` | `disableHyros` |
|  | `POST` | `/groups/{id}/disable-lockdown` | `disableGroupLockdown` |
|  | `POST` | `/groups/{id}/disable-meta-conversions` | `disableMetaPixel` |
|  | `POST` | `/groups/{id}/disable-min-chat-level` | `disableGroupMinChatLevel` |
|  | `POST` | `/groups/{id}/disable-min-post-level` | `disableGroupMinPostLevel` |
|  | `POST` | `/groups/{id}/disable-onboarding-video` | `disableGroupOnboardingVideo` |
|  | `POST` | `/groups/{id}/disable-survey` | `disableSurvey` |
|  | `POST` | `/groups/{id}/disable-webhook` | `disableWebhook` |
|  | `POST` | `/groups/{id}/disable-zapier` | `disableZapier` |
|  | `POST` | `/groups/{id}/disconnect-google-ads` | `disconnectGoogleAds` |
|  | `POST` | `/groups/{id}/disconnect-meta-conversions` | `disconnectMetaPixel` |
|  | `GET` | `/groups/{id}/discovery` | `getGroupDiscoveryData` |
|  | `POST` | `/groups/{id}/discovery-keywords` | `updateGroupKeywords` |
|  | `GET` | `/groups/{id}/discovery/boost-retention` | `getBoostRetention` |
|  | `PUT` | `/groups/{id}/downgrade-legacy` | `downgradeLegacyGroup` |
|  | `POST` | `/groups/{id}/enable-auto-dm` | `enableAutoDm` |
|  | `POST` | `/groups/{id}/enable-google-ads` | `enableGoogleAds` |
|  | `POST` | `/groups/{id}/enable-growth-boost` | `enableGrowthBoost` |
|  | `POST` | `/groups/{id}/enable-hyros` | `enableHyros` |
|  | `POST` | `/groups/{id}/enable-lockdown` | `enableGroupLockdown` |
|  | `POST` | `/groups/{id}/enable-meta-conversions` | `enableMetaPixel` |
|  | `POST` | `/groups/{id}/enable-min-chat-level` | `enableGroupMinChatLevel` |
|  | `POST` | `/groups/{id}/enable-min-post-level` | `enableGroupMinPostLevel` |
|  | `POST` | `/groups/{id}/enable-onboarding-video` | `enableGroupOnboardingVideo` |
|  | `POST` | `/groups/{id}/enable-survey` | `enableSurvey` |
|  | `POST` | `/groups/{id}/enable-webhook` | `enableWebhook` |
|  | `POST` | `/groups/{id}/enable-zapier` | `enableZapier` |
|  | `POST` | `/groups/{id}/end-trial` | `endTrial` |
|  | `GET` | `/groups/{id}/get-billing-products-data` | `getBillingProducts` |
|  | `GET` | `/groups/{id}/get-meta-pixel-id` | `getMetaPixelId` |
|  | `POST` | `/groups/{id}/go-live` | `createAdHocLiveCall` |
|  | `POST` | `/groups/{id}/grant-course-access` | `grantCourseAccess` |
|  | `GET` | `/groups/{id}/hobby-eligibility` | `getGroupHobbyEligibility` |
|  | `POST` | `/groups/{id}/init-billing-setup` | `initBillingSetup` |
|  | `POST` | `/groups/{id}/init-join-group-paid` | `initJoinGroupPaid` |
|  | `POST` | `/groups/{id}/invite` | `inviteUsersToGroup` |
|  | `GET` | `/groups/{id}/invoices` | `getGroupInvoices` |
|  | `POST` | `/groups/{id}/join-group` | `joinGroup` |
|  | `POST` | `/groups/{id}/join-group-paid` | `joinGroupPaid` |
| ✅ | `GET` | `/groups/{id}/labels` | `getGroupLabels` |
| ✅ | `GET` | `/groups/{id}/labels/` | `readGroupLabel` |
|  | `POST` | `/groups/{id}/leave` | `leaveGroup` |
| ✅ | `GET` | `/groups/{id}/levels` | `getGroupLevels` |
|  | `PUT` | `/groups/{id}/levels/` | `updateGroupLevel` |
|  | `GET` | `/groups/{id}/links` | `getGroupLinks` |
|  | `POST` | `/groups/{id}/links` | `addGroupLink` |
|  | `DELETE` | `/groups/{id}/links/` | `deleteGroupLink` |
|  | `PUT` | `/groups/{id}/links/` | `updateGroupLink` |
| ✅ | `GET` | `/groups/{id}/member-course-permissions` | `getMemberCoursePermissions` |
|  | `GET` | `/groups/{id}/member-membership-billing-invoice` | `getSubscriptionInvoiceAdmin` |
|  | `PUT` | `/groups/{id}/membership-model` | `setGroupMembershipModel` |
|  | `GET` | `/groups/{id}/membership-products` | `getGroupMembershipProducts` |
|  | `POST` | `/groups/{id}/membership-products` | `createMembershipProduct` |
|  | `DELETE` | `/groups/{id}/membership-products/` | `deleteGroupMembershipProduct` |
|  | `PUT` | `/groups/{id}/membership-products/` | `updateMembershipProduct` |
|  | `PUT` | `/groups/{id}/min-chat-level` | `updateGroupMinChatLevel` |
|  | `PUT` | `/groups/{id}/min-post-level` | `updateGroupMinPostLevel` |
|  | `POST` | `/groups/{id}/move-label` | `updateGroupLabelOrder` |
|  | `POST` | `/groups/{id}/move-link` | `updateGroupLinkOrder` |
|  | `POST` | `/groups/{id}/move-rule` | `updateGroupRuleOrder` |
|  | `POST` | `/groups/{id}/move-survey-question` | `moveSurveyQuestion` |
|  | `PUT` | `/groups/{id}/paid-name` | `paidRenameGroup` |
|  | `PUT` | `/groups/{id}/payment-method` | `updateGroupPaymentMethod` |
|  | `GET` | `/groups/{id}/post-detail` | `getPostDetail` |
|  | `POST` | `/groups/{id}/reactivate` | `reactivateGroup` |
|  | `POST` | `/groups/{id}/reactivate-billing-subscription` | `reactivateGroupSubscription` |
|  | `POST` | `/groups/{id}/remove-billing-manager` | `removeBillingManager` |
|  | `POST` | `/groups/{id}/remove-landing-page-attachment` | `deleteLandingPageAttachment` |
|  | `POST` | `/groups/{id}/request-bulk-action` | `membersBulkActions` |
|  | `POST` | `/groups/{id}/resend-invite-email` | `resendEmailInvite` |
|  | `POST` | `/groups/{id}/reset-group-billing-setup` | `resetGroupBillingSetup` |
| ✅ | `GET` | `/groups/{id}/reviews` | `getGroupReviews` |
|  | `POST` | `/groups/{id}/reviews` | `postReview` |
|  | `DELETE` | `/groups/{id}/reviews/` | `deleteReview` |
|  | `POST` | `/groups/{id}/reviews/` | `reportReview` |
|  | `PUT` | `/groups/{id}/reviews/` | `updateReview` |
|  | `GET` | `/groups/{id}/reviews/self` | `getUserGroupReview` |
|  | `POST` | `/groups/{id}/revoke-invite-email` | `revokeEmailInvite` |
| ✅ | `GET` | `/groups/{id}/rules` | `getGroupRules` |
|  | `POST` | `/groups/{id}/rules` | `addGroupRule` |
|  | `DELETE` | `/groups/{id}/rules/` | `deleteGroupRule` |
|  | `PUT` | `/groups/{id}/rules/` | `editGroupRule` |
|  | `POST` | `/groups/{id}/search-course-references` | `searchCourseModules` |
|  | `POST` | `/groups/{id}/submit-survey-answers` | `submitSurvey` |
|  | `PUT` | `/groups/{id}/subscription` | `updateGroupSubscription` |
|  | `GET` | `/groups/{id}/subscription-preview` | `getPreviewSubscriptionChange` |
|  | `POST` | `/groups/{id}/tabs/` | `setGroupTabVisible` |
|  | `POST` | `/groups/{id}/tabs/` | `setGroupTabHidden` |
|  | `POST` | `/groups/{id}/test-meta-conversions` | `testMetaPixel` |
|  | `POST` | `/groups/{id}/update-auto-affiliate-user` | `updateGroupAutoAffiliateUser` |
|  | `POST` | `/groups/{id}/update-auto-dm-message` | `updateAutoDmMessage` |
|  | `POST` | `/groups/{id}/update-auto-dm-user` | `updateAutoDmUser` |
|  | `POST` | `/groups/{id}/update-invoice-fields` | `updateGroupInvoiceFields` |
|  | `POST` | `/groups/{id}/update-landing-page-attachment-position` | `updateLandingPageAttachmentPosition` |
|  | `POST` | `/groups/{id}/update-landing-page-description` | `updateLandingPageDescription` |
|  | `POST` | `/groups/{id}/update-member-course-permission` | `updateMemberCoursePermission` |
|  | `POST` | `/groups/{id}/update-name` | `renameGroup` |
|  | `POST` | `/groups/{id}/update-onboarding-video` | `updateGroupOnboardingVideo` |
|  | `POST` | `/groups/{id}/update-retention-video` | `updateGroupRetentionVideo` |
|  | `POST` | `/groups/{id}/update-support-email` | `updateConnectAccount` |
|  | `POST` | `/groups/{id}/update-survey-question` | `editSurveyQuestion` |
|  | `PUT` | `/groups/{id}/upgrade-legacy` | `upgradeLegacyGroup` |
|  | `POST` | `/groups/{id}/verify-invite-code` | `verifyGroupInviteCode` |
|  | `POST` | `/groups/{id}/webhooks` | `createGroupInviteWebhook` |

### Members and memberships

| | method | endpoint | `apiClient` |
|---|---|---|---|
|  | `POST` | `/members/{id}/disable-new-customer-notification` | `disableNewCustomerNotification` |
|  | `POST` | `/members/{id}/enable-new-customer-notification` | `enableNewCustomerNotification` |
|  | `POST` | `/members/{id}/hide-support-email-banner` | `hideSupportEmailBanner` |
|  | `POST` | `/members/{id}/how-reviews-work-dismissed` | `dismissHowReviewsWork` |
|  | `GET` | `/members/{id}/invoices` | `getMemberPaymentHistory` |
|  | `POST` | `/members/{id}/invoices/` | `retryInvoicePayment` |
|  | `POST` | `/members/{id}/leave-a-review-dismissed` | `dismissLeaveReview` |
|  | `POST` | `/members/{id}/onboarding-dismiss-widget` | `dismissOnboardingWidget` |
|  | `POST` | `/members/{id}/onboarding-post-commented` | `setMemberPostCommented` |
|  | `POST` | `/members/{id}/onboarding-video-watched` | `setMemberOnboardingVideoWatched` |
|  | `POST` | `/members/{id}/refunds` | `refundPayment` |
| ✅ | `POST` | `/members/{id}/role` | `updateMemberRole` |
|  | `POST` | `/members/{id}/tier-overrides` | `overrideMemberTier` |
|  | `PUT` | `/members/{id}/verification` | `verifyMember` |

### The signed-in account

| | method | endpoint | `apiClient` |
|---|---|---|---|
|  | `POST` | `/self/add-payment-method` | `addPaymentMethod` |
|  | `POST` | `/self/admin-onboarding-video-watched` | `setUserAdminOnboardingWatched` |
|  | `GET` | `/self/billing-manager-groups` | `getBillingManagerGroups` |
|  | `GET` | `/self/chat-blocked-users` | `listBlockedUsers` |
| ✅ | `GET` | `/self/chat-channels` | `getChannels` |
|  | `POST` | `/self/chat-channels/read` | `markAllChatMessageRead` |
|  | `PUT` | `/self/customer-details` | `setCustomerDetails` |
|  | `POST` | `/self/disable-robots-noindex` | `disableRobotsNoindex` |
|  | `POST` | `/self/enable-robots-noindex` | `enableRobotsNoindex` |
| ✅ | `GET` | `/self/groups` | `readSelfGroups` |
|  | `POST` | `/self/hide-group-from-switcher` | `hideGroupFromSwitcher` |
|  | `POST` | `/self/hide-group-on-profile` | `disableMembershipVisibility` |
|  | `GET` | `/self/invoices` | `getSelfInvoices` |
|  | `GET` | `/self/list-visibility-groups` | `getMembershipVisibility` |
|  | `GET` | `/self/location` | `getSelfLocation` |
|  | `PUT` | `/self/location` | `updateSelfLocation` |
|  | `POST` | `/self/location/opt-out` | `removeSelfLocation` |
|  | `PUT` | `/self/membership-payment-methods` | `updatePaymentMethodForGroup` |
|  | `PUT` | `/self/memberships` | `updateMembershipSubscriptionInterval` |
|  | `PUT` | `/self/memberships` | `changeMembershipTier` |
|  | `GET` | `/self/memberships/{id}/group-membership-product` | `getSelfGroupMembershipProduct` |
|  | `PUT` | `/self/name2` | `updateSelfName2` |
| ✅ | `GET` | `/self/notifications` | `listNotificationMessages` |
|  | `GET` | `/self/payment-methods` | `getPaymentMethods` |
|  | `DELETE` | `/self/payout-account` | `resetPayoutAccount` |
|  | `POST` | `/self/payout-account` | `setupPayoutAccount` |
|  | `POST` | `/self/payout-account-session` | `getPayoutAccountSession` |
|  | `PUT` | `/self/payout-account/payout-method` | `storePayoutMethod` |
|  | `GET` | `/self/payouts` | `getSelfPayouts` |
|  | `POST` | `/self/pin-group-on-pinned-switcher` | `pinGroup` |
|  | `GET` | `/self/prefs/{id}` | `getPrefs` |
|  | `POST` | `/self/prefs/{id}` | `postPrefs` |
|  | `POST` | `/self/register-push-token` | `registerAppPushToken` |
|  | `POST` | `/self/remove-payment-method` | `removePaymentMethod` |
|  | `POST` | `/self/request-change-email` | `requestEmailChange` |
|  | `POST` | `/self/send-support-message` | `submitSupportTicket` |
|  | `POST` | `/self/set-theme` | `updateTheme` |
|  | `POST` | `/self/setup-payment-method` | `createMembershipBilling` |
|  | `POST` | `/self/show-group-on-profile` | `enableMembershipVisibility` |
|  | `POST` | `/self/sync-unread-notification-count` | `syncUnreadNotificationCount` |
|  | `POST` | `/self/transfer-payment-method` | `transferSubscriptions` |
|  | `POST` | `/self/transfer-payment-method-memberships` | `transferPaymentMethodMembership` |
|  | `POST` | `/self/unhide-group-from-switcher` | `unhideGroupFromSwitcher` |
|  | `POST` | `/self/unpin-group-on-pinned-switcher` | `unpinGroup` |
|  | `POST` | `/self/unregister-push-token` | `unregisterAppPushToken` |
|  | `PUT` | `/self/update-user-membership-invoice-fields` | `updateUserInvoiceFields` |
|  | `POST` | `/self/user-attributions` | `updateUserAttributions` |
|  | `GET` | `/self/user-membership-invoice-fields` | `getUserInvoiceFields` |
|  | `POST` | `/self/verify-change-email` | `verifyEmailChange` |

### Other users

| | method | endpoint | `apiClient` |
|---|---|---|---|
|  | `GET` | `/users/{id}` | `readUser` |
|  | `POST` | `/users/{id}/app-downloaded` | `setUserAppDownloaded` |
|  | `POST` | `/users/{id}/chat-block` | `blockChat` |
| ✅ | `POST` | `/users/{id}/chat-request` | `sendChatRequest` |
|  | `POST` | `/users/{id}/chat-unblock` | `unblockChat` |
|  | `DELETE` | `/users/{id}/follow` | `unfollowUser` |
|  | `POST` | `/users/{id}/follow` | `followUser` |
|  | `DELETE` | `/users/{id}/follower` | `removeFollower` |
|  | `GET` | `/users/{id}/groups` | `readUserGroups` |
|  | `PUT` | `/users/{id}/metadata/` | `updateUserMeta` |
|  | `GET` | `/users/{id}/preview` | `previewUser` |
|  | `POST` | `/users/{id}/report` | `reportUser` |
|  | `GET` | `/users/{id}/reviews` | `getUserReviews` |
|  | `POST` | `/users/{id}/update-group-position?group=` | `updateGroupPosition` |
|  | `POST` | `/users/{id}/update-name` | `renameUser` |

### Direct messages

| | method | endpoint | `apiClient` |
|---|---|---|---|
| ✅ | `GET` | `/channels/{id}/messages` | `getChannelMessages` |
| ✅ | `POST` | `/channels/{id}/messages` | `sendMessage` |
| ✅ | `POST` | `/channels/{id}/read` | `markChatMessageRead` |
|  | `POST` | `/channels/{id}/unread` | `markChatMessageUnread` |

### Files and attachments

| | method | endpoint | `apiClient` |
|---|---|---|---|
|  | `GET` | `/files` | `readFiles` |
| ✅ | `POST` | `/files` | `createFile` |
|  | `DELETE` | `/files/{id}` | `deleteFile` |
|  | `POST` | `/files/{id}/download-url` | `getResourceUrl` |

### Classroom

| | method | endpoint | `apiClient` |
|---|---|---|---|
|  | `POST` | `/courses` | `createCourse` |
|  | `DELETE` | `/courses/{id}` | `deleteCourse` |
|  | `GET` | `/courses/{id}` | `getCourse` |
|  | `PUT` | `/courses/{id}` | `updateCourse` |
|  | `POST` | `/courses/{id}/clone-code` | `createCourseShareKey` |
|  | `POST` | `/courses/{id}/duplicate` | `duplicateCourse` |
|  | `POST` | `/courses/{id}/import` | `importCourse` |
|  | `POST` | `/courses/{id}/lock-free-trial` | `updateCourseLockFreeTrial` |
|  | `POST` | `/courses/{id}/mark-done` | `markCourseDone` |
|  | `POST` | `/courses/{id}/mark-undone` | `markCourseUndone` |
|  | `POST` | `/courses/{id}/move-pinned-post` | `updatePinnedModulePostPosition` |
|  | `POST` | `/courses/{id}/move2` | `moveCourse` |
|  | `PUT` | `/courses/{id}/state` | `updateCourseState` |
|  | `POST` | `/courses/{id}/unlock` | `unlockCourse` |
|  | `POST` | `/courses/{id}/update-drip` | `updateCourseDrip` |
|  | `POST` | `/courses/{id}/update-parent` | `updateCourseParent` |
|  | `POST` | `/videos` | `createMuxVideo` |
|  | `GET` | `/videos/{id}` | `getMuxVideo` |
|  | `POST` | `/videos/{id}/download-url` | `downloadMuxVideo` |
|  | `POST` | `/videos/{id}/request-data` | `getMuxVideoData` |
|  | `PUT` | `/videos/{id}/thumbnail` | `updateMuxThumbnail` |
|  | `POST` | `/videos/{id}/tokens` | `getMuxTokens` |
|  | `GET` | `/videos/{id}/transcript-id` | `getMuxTranscriptID` |

### Billing and payments

| | method | endpoint | `apiClient` |
|---|---|---|---|
|  | `GET` | `/billing/payouts/fields` | `getPayoutAttributes` |
|  | `GET` | `/billing/payouts/remediation-links` | `getPayoutRemediationLinks` |
|  | `GET` | `/billing/payouts/routes` | `getPayoutRoutes` |
|  | `GET` | `/billing/preview-tax` | `previewTax` |
|  | `POST` | `/billing/transactions` | `purchase` |
|  | `POST` | `/payments/cancel-subscription` | `cancelSubscription` |
|  | `POST` | `/payments/cancel-trial` | `cancelTrial` |
|  | `POST` | `/payments/setup-create-group` | `setupCreateGroup` |
|  | `POST` | `/payments/uncancel-subscription` | `uncancelSubscription` |
|  | `POST` | `/payments/update-payment-method` | `updatePaymentMethod` |

### Affiliates

| | method | endpoint | `apiClient` |
|---|---|---|---|
|  | `GET` | `/affiliates` | `getAffiliate` |
|  | `GET` | `/affiliates/customer-data` | `getAffiliateCustomerData` |
|  | `GET` | `/affiliates/payout` | `getAffiliatesPayoutInfo` |
|  | `GET` | `/affiliates/referred-groups` | `getMembershipAffiliateGroups` |
|  | `POST` | `/affiliates/request-payout` | `requestAffiliatePayout` |
|  | `POST` | `/affiliates/set-customer-data` | `setAffiliateCustomerData` |
|  | `GET` | `/affiliates/v2/compensations` | `listAffiliateCompensations` |
|  | `POST` | `/affiliates/verify-code` | `getAffiliateCustomerDataNoAuth` |

### Search

| | method | endpoint | `apiClient` |
|---|---|---|---|
|  | `POST` | `/search/chat-users` | `searchChatUsers` |
| ✅ | `POST` | `/search/users` | `searchUsers` |

### Other

| | method | endpoint | `apiClient` |
|---|---|---|---|
|  | `POST` | `/auth/change-password` | `changePassword` |
|  | `POST` | `/auth/email-verify` | `emailVerify` |
|  | `POST` | `/auth/email-verify-init` | `emailVerifyInit` |
|  | `POST` | `/auth/login` | `login` |
|  | `POST` | `/auth/login-with-code` | `loginWithCode` |
|  | `POST` | `/auth/login-with-code-init` | `requestLoginCode` |
|  | `POST` | `/auth/login-with-token` | `loginWithToken` |
|  | `POST` | `/auth/logout-all` | `logoutEverywhere` |
|  | `POST` | `/auth/request-signup` | `requestSignUp` |
|  | `POST` | `/auth/reset-password` | `resetPassword` |
|  | `POST` | `/auth/reset-password-init` | `requestPasswordReset` |
|  | `DELETE` | `/auth/session` | `logout` |
|  | `POST` | `/auth/verify-signup` | `verifySignUp` |
|  | `POST` | `/calendar-events` | `createCalendarEventV2` |
|  | `DELETE` | `/calendar-events/{id}` | `deleteCalendarEventV2` |
|  | `GET` | `/calendar-events/{id}` | `getCalendarEventV2` |
|  | `PUT` | `/calendar-events/{id}` | `updateCalendarEventV2` |
|  | `POST` | `/calendar-events/{id}/ics-download` | `getCalendarICSUrlV2` |
|  | `DELETE` | `/calendar-events/{id}/occurrence/` | `deleteCalendarEventOccurrenceV2` |
|  | `PUT` | `/calendar-events/{id}/occurrence/` | `updateCalendarEventOccurrenceV2` |
|  | `POST` | `/labels` | `createLabel` |
|  | `DELETE` | `/labels/{id}` | `deleteLabel` |
|  | `PUT` | `/labels/{id}` | `updateLabel` |
|  | `POST` | `/live/feedback` | `submitLiveCallFeedback` |
|  | `PUT` | `/live/feedback` | `updateLiveCallFeedback` |
|  | `POST` | `/live/get-token` | `getLiveCallToken` |
|  | `POST` | `/live/update-call-type` | `updateLiveCallType` |
|  | `POST` | `/messages` | `markMessagesAsRead` |
|  | `POST` | `/messages/{id}/read` | `markMessageAsRead` |
|  | `POST` | `/messages/{id}/unread` | `markMessageAsUnread` |
|  | `POST` | `/submit-application` | `careersApply` |
|  | `GET` | `/validate-group-name` | `validateGroupName` |
|  | `POST` | `/video-meta` | `getVideoMeta` |
|  | `GET` | `/wait` | `getWait` |

