import { getCurrentHub, startTransaction } from '@sentry/browser';
import { Transaction } from '@sentry/types';
import { handleAuthErrors } from 'app/accounts/actions';
import { DestinyAccount } from 'app/accounts/destiny-account';
import { getPlatforms } from 'app/accounts/platforms';
import { currentAccountSelector } from 'app/accounts/selectors';
import { loadClarity } from 'app/clarity/descriptions/loadDescriptions';
import { customStatsSelector } from 'app/dim-api/selectors';
import { processInGameLoadouts } from 'app/loadout-drawer/loadout-type-converters';
import { inGameLoadoutLoaded } from 'app/loadout/ingame/actions';
import { loadCoreSettings } from 'app/manifest/actions';
import { d2ManifestSelector, manifestSelector } from 'app/manifest/selectors';
import { get, set } from 'app/storage/idb-keyval';
import { ThunkResult } from 'app/store/types';
import { DimError } from 'app/utils/dim-error';
import { errorLog, infoLog, timer, warnLog } from 'app/utils/log';
import { convertToError, errorMessage } from 'app/utils/util';
import { DestinyItemComponent, DestinyProfileResponse } from 'bungie-api-ts/destiny2';
import { BucketHashes } from 'data/d2/generated-enums';
import { getCharacters as d1GetCharacters } from '../bungie-api/destiny1-api';
import { getCharacters, getStores } from '../bungie-api/destiny2-api';
import { bungieErrorToaster } from '../bungie-api/error-toaster';
import { D2ManifestDefinitions, getDefinitions } from '../destiny2/d2-definitions';
import { bungieNetPath } from '../dim-ui/BungieImage';
import { showNotification } from '../notifications/notifications';
import { loadingTracker } from '../shell/loading-tracker';
import { reportException } from '../utils/exceptions';
import {
  CharacterInfo,
  charactersUpdated,
  error,
  loadNewItems,
  profileError,
  profileLoaded,
  update,
} from './actions';
import { cleanInfos } from './dim-item-info';
import { d2BucketsSelector, storesLoadedSelector, storesSelector } from './selectors';
import { DimStore } from './store-types';
import { getCharacterStatsData as getD1CharacterStatsData } from './store/character-utils';
import { ItemCreationContext, processItems } from './store/d2-item-factory';
import { getCharacterStatsData, makeCharacter, makeVault } from './store/d2-store-factory';
import { resetItemIndexGenerator } from './store/item-index';

/**
 * Update the high level character information for all the stores
 * (level, power, stats, etc.). This does not update the
 * items in the stores.
 *
 * This works on both D1 and D2.
 *
 * TODO: Instead of this, update per-character after equip/dequip
 */
export function updateCharacters(): ThunkResult {
  return async (dispatch, getState) => {
    const account = currentAccountSelector(getState());
    if (!account) {
      return;
    }

    const defs = manifestSelector(getState());
    if (!defs) {
      return;
    }

    let characters: CharacterInfo[] = [];
    if (account.destinyVersion === 2) {
      const profileInfo = await getCharacters(account);
      characters = profileInfo.characters.data
        ? Object.values(profileInfo.characters.data).map((character) => ({
            characterId: character.characterId,
            level: character.levelProgression.level,
            powerLevel: character.light,
            background: bungieNetPath(character.emblemBackgroundPath),
            icon: bungieNetPath(character.emblemPath),
            stats: getCharacterStatsData(d2ManifestSelector(getState())!, character.stats),
            color: character.emblemColor,
          }))
        : [];
    } else {
      const profileInfo = await d1GetCharacters(account);
      characters = profileInfo.characters.map((character) => {
        const characterBase = character.characterBase;
        return {
          characterId: characterBase.characterId,
          level: character.characterLevel,
          powerLevel: characterBase.powerLevel,
          percentToNextLevel: character.percentToNextLevel / 100,
          background: bungieNetPath(character.backgroundPath),
          icon: bungieNetPath(character.emblemPath),
          stats: getD1CharacterStatsData(getState().manifest.d1Manifest!, characterBase),
        };
      });
    }

    // If we switched account since starting this, give up
    if (account !== currentAccountSelector(getState())) {
      return;
    }

    dispatch(charactersUpdated(characters));
  };
}

let firstTime = true;

/**
 * Returns a promise for a fresh view of the stores and their items.
 */
export function loadStores(): ThunkResult<DimStore[] | undefined> {
  return async (dispatch, getState) => {
    let account = currentAccountSelector(getState());
    if (!account) {
      // TODO: throw here?
      await dispatch(getPlatforms());
      account = currentAccountSelector(getState());
      if (!account || account.destinyVersion !== 2) {
        return;
      }
    }

    dispatch(loadCoreSettings()); // no need to wait
    $featureFlags.clarityDescriptions && dispatch(loadClarity()); // no need to await
    await dispatch(loadNewItems(account));
    // The first time we load, allow the data to be loaded from IDB. We then do a second
    // load to make sure that we immediately try to get remote data.
    if (firstTime) {
      firstTime = false;
      await dispatch(loadStoresData(account, firstTime));
    }
    const stores = await dispatch(loadStoresData(account, firstTime));
    return stores;
  };
}

// time in milliseconds after which we could expect Bnet to return an updated response
const BUNGIE_CACHE_TTL = 15_000;

let minimumCacheAge = Number.MAX_SAFE_INTEGER;

function loadProfile(
  account: DestinyAccount,
  firstTime: boolean
): ThunkResult<DestinyProfileResponse | undefined> {
  return async (dispatch, getState) => {
    const mockProfileData = getState().inventory.mockProfileData;
    if (mockProfileData) {
      // TODO: can/should we replace this with profileResponse plus the readOnly flag?
      return mockProfileData;
    }

    // First try loading from IndexedDB
    let profileResponse = getState().inventory.profileResponse;
    if (!profileResponse) {
      profileResponse = await get<DestinyProfileResponse>(`profile-${account.membershipId}`);
      // Check to make sure the profile hadn't been loaded in the meantime
      if (getState().inventory.profileResponse) {
        profileResponse = getState().inventory.profileResponse;
      } else {
        infoLog('d2-stores', 'Loaded cached profile from IndexedDB');
        dispatch(profileLoaded({ profile: profileResponse, live: false }));
        // The first time we load, just use the IDB version if we can, to speed up loading
        if (firstTime) {
          return profileResponse;
        }
      }
    }

    let cachedProfileMintedDate = new Date(0);

    // If our cached profile is up to date
    if (profileResponse) {
      // TODO: need to make sure we still load at the right frequency / for manual cache busts?
      cachedProfileMintedDate = new Date(profileResponse.responseMintedTimestamp ?? 0);
      const profileAge = Date.now() - cachedProfileMintedDate.getTime();
      if (!storesLoadedSelector(getState()) && profileAge > 0 && profileAge < BUNGIE_CACHE_TTL) {
        warnLog(
          'd2-stores',
          'Cached profile is within Bungie.net cache time, skipping remote load.',
          profileAge
        );
        return profileResponse;
      } else {
        warnLog(
          'd2-stores',
          'Cached profile is older than Bungie.net cache time, proceeding.',
          profileAge
        );
      }
    }

    try {
      const remoteProfileResponse = await getStores(account);
      const remoteProfileMintedDate = new Date(remoteProfileResponse.responseMintedTimestamp ?? 0);

      // compare new response against cached response, toss if it's not newer!
      if (profileResponse) {
        if (remoteProfileMintedDate.getTime() <= cachedProfileMintedDate.getTime()) {
          warnLog(
            'd2-stores',
            'Profile from Bungie.net was not newer than cached profile, discarding.',
            remoteProfileMintedDate,
            cachedProfileMintedDate
          );
          // Clear the error since we did load correctly
          dispatch(profileError(undefined));
          // undefined means skip processing, in case we already have computed stores
          return storesLoadedSelector(getState()) ? undefined : profileResponse;
        } else {
          minimumCacheAge = Math.min(
            minimumCacheAge,
            remoteProfileMintedDate.getTime() - cachedProfileMintedDate.getTime()
          );
          infoLog(
            'd2-stores',
            'Profile from Bungie.net was newer than cached profile, using it.',
            remoteProfileMintedDate.getTime() - cachedProfileMintedDate.getTime(),
            minimumCacheAge,
            remoteProfileMintedDate,
            cachedProfileMintedDate
          );
        }
      }

      profileResponse = remoteProfileResponse;
      set(`profile-${account.membershipId}`, profileResponse); // don't await
      dispatch(profileLoaded({ profile: profileResponse, live: true }));
      return profileResponse;
    } catch (e) {
      dispatch(handleAuthErrors(e));
      dispatch(profileError(convertToError(e)));
      if (profileResponse) {
        errorLog(
          'd2-stores',
          'Error loading profile from Bungie.net, falling back to cached profile',
          e
        );
        // undefined means skip processing, in case we already have computed stores
        return storesLoadedSelector(getState()) ? undefined : profileResponse;
      }
      // rethrow
      throw e;
    }
  };
}

function loadStoresData(
  account: DestinyAccount,
  firstTime: boolean
): ThunkResult<DimStore[] | undefined> {
  return async (dispatch, getState) => {
    const promise = (async () => {
      // If we switched account since starting this, give up
      if (account !== currentAccountSelector(getState())) {
        return;
      }

      const transaction = $featureFlags.sentry
        ? startTransaction({ name: 'loadStoresD2' })
        : undefined;
      // set the transaction on the scope so it picks up any errors
      getCurrentHub()?.configureScope((scope) => scope.setSpan(transaction));

      resetItemIndexGenerator();

      try {
        const { readOnly } = getState().inventory;

        const [defs, profileResponse] = await Promise.all([
          dispatch(getDefinitions())!,
          dispatch(loadProfile(account, firstTime)),
        ]);

        // If we switched account since starting this, give up
        if (account !== currentAccountSelector(getState())) {
          return;
        }

        if (!defs || !profileResponse) {
          return;
        }

        const stopTimer = timer('Process inventory');

        const buckets = d2BucketsSelector(getState())!;
        const customStats = customStatsSelector(getState());
        const stores = buildStores(
          {
            defs,
            buckets,
            customStats,
            profileResponse,
          },
          transaction
        );

        if (readOnly) {
          for (const store of stores) {
            store.hadErrors = true;
            for (const item of store.items) {
              item.lockable = false;
              item.trackable = false;
              item.notransfer = true;
              item.taggable = false;
            }
          }
        }

        // TODO: we can start moving some of this stuff to selectors? characters too
        const currencies = processCurrencies(profileResponse, defs);

        const loadouts = processInGameLoadouts(profileResponse, defs);

        stopTimer();

        const stateSpan = transaction?.startChild({
          op: 'updateInventoryState',
        });
        const stopStateTimer = timer('Inventory state update');

        // If we switched account since starting this, give up before saving
        if (account !== currentAccountSelector(getState())) {
          return;
        }

        dispatch(cleanInfos(stores));
        dispatch(update({ stores, currencies }));
        dispatch(inGameLoadoutLoaded(loadouts));

        stopStateTimer();
        stateSpan?.finish();

        return stores;
      } catch (e) {
        errorLog('d2-stores', 'Error loading stores', e);
        reportException('d2stores', e);

        // If we switched account since starting this, give up
        if (account !== currentAccountSelector(getState())) {
          return;
        }

        dispatch(handleAuthErrors(e));

        if (storesSelector(getState()).length > 0) {
          // don't replace their inventory with the error, just notify
          showNotification(bungieErrorToaster(errorMessage(e)));
        } else {
          dispatch(error(convertToError(e)));
        }
        return undefined;
      } finally {
        transaction?.finish();
      }
    })();
    loadingTracker.addPromise(promise);
    return promise;
  };
}

export function buildStores(
  itemCreationContext: ItemCreationContext,
  transaction?: Transaction
): DimStore[] {
  // TODO: components may be hidden (privacy)

  const { profileResponse } = itemCreationContext;

  if (
    !profileResponse.profileInventory.data ||
    !profileResponse.characterInventories.data ||
    !profileResponse.characters.data
  ) {
    errorLog(
      'd2-stores',
      'Vault or character inventory was missing - bailing in order to avoid corruption'
    );
    throw new DimError('BungieService.MissingInventory');
  }

  const lastPlayedDate = findLastPlayedDate(profileResponse);

  const processSpan = transaction?.startChild({
    op: 'processItems',
  });
  const vault = processVault(itemCreationContext);

  const characters = Object.keys(profileResponse.characters.data).map((characterId) =>
    processCharacter(itemCreationContext, characterId, lastPlayedDate)
  );
  processSpan?.finish();

  const stores = [...characters, vault];

  return stores;
}

function processCurrencies(profileInfo: DestinyProfileResponse, defs: D2ManifestDefinitions) {
  const profileCurrencies = profileInfo.profileCurrencies.data
    ? profileInfo.profileCurrencies.data.items
    : [];
  const currencies = profileCurrencies.map((c) => ({
    itemHash: c.itemHash,
    quantity: c.quantity,
    displayProperties: defs.InventoryItem.get(c.itemHash)?.displayProperties ?? {
      name: 'Unknown',
      description: 'Unknown item',
    },
  }));
  return currencies;
}

/**
 * Process a single character from its raw form to a DIM store, with all the items.
 */
function processCharacter(
  itemCreationContext: ItemCreationContext,
  characterId: string,
  lastPlayedDate: Date
): DimStore {
  const { defs, buckets, profileResponse } = itemCreationContext;
  const character = profileResponse.characters.data![characterId];
  const characterInventory = profileResponse.characterInventories.data?.[characterId]?.items || [];
  const profileInventory = profileResponse.profileInventory.data?.items || [];
  const characterEquipment = profileResponse.characterEquipment.data?.[characterId]?.items || [];
  const profileRecords = profileResponse.profileRecords?.data;

  const store = makeCharacter(defs, character, lastPlayedDate, profileRecords);

  // We work around the weird account-wide buckets by assigning them to the current character
  const items = characterInventory.concat(characterEquipment);

  if (store.current) {
    for (const i of profileInventory) {
      const bucket = buckets.byHash[i.bucketHash];
      // items that can be stored in a vault
      if (bucket && (bucket.vaultBucket || bucket.hash === BucketHashes.SpecialOrders)) {
        items.push(i);
      }
    }
  }

  store.items = processItems(itemCreationContext, store, items);
  return store;
}

function processVault(itemCreationContext: ItemCreationContext): DimStore {
  const { buckets, profileResponse } = itemCreationContext;
  const profileInventory = profileResponse.profileInventory.data
    ? profileResponse.profileInventory.data.items
    : [];

  const store = makeVault();

  const items: DestinyItemComponent[] = [];
  for (const i of profileInventory) {
    const bucket = buckets.byHash[i.bucketHash];
    // items that cannot be stored in the vault, and are therefore *in* a vault
    if (bucket && !bucket.vaultBucket && bucket.hash !== BucketHashes.SpecialOrders) {
      items.push(i);
    }
  }

  store.items = processItems(itemCreationContext, store, items);
  return store;
}

/**
 * Find the date of the most recently played character.
 */
function findLastPlayedDate(profileInfo: DestinyProfileResponse) {
  const dateLastPlayed = profileInfo.profile.data?.dateLastPlayed;
  if (dateLastPlayed) {
    return new Date(dateLastPlayed);
  }
  return new Date(0);
}
