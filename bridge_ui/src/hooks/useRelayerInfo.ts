import {
  ChainId,
  CHAIN_ID_AVAX,
  CHAIN_ID_BSC,
  CHAIN_ID_ETH,
  CHAIN_ID_OASIS,
  CHAIN_ID_POLYGON,
  CHAIN_ID_SOLANA,
  CHAIN_ID_TERRA,
} from "@certusone/wormhole-sdk";
import { hexToNativeString } from "@certusone/wormhole-sdk/lib/esm/utils";
import axios from "axios";
import { useEffect, useMemo, useState } from "react";
import { useSelector } from "react-redux";
import { DataWrapper } from "../store/helpers";
import {
  selectTransferGasPrice,
  selectTransferSourceParsedTokenAccount,
} from "../store/selectors";
import { getCoinGeckoURL, RELAYER_COMPARE_ASSET } from "../utils/consts";
import useRelayersAvailable, { RelayerTokenInfo } from "./useRelayersAvailable";

export function getRelayAssetInfo(
  originChain: ChainId,
  originAsset: string,
  info: RelayerTokenInfo
) {
  if (!originChain || !originAsset || !info) {
    return null;
  }
  return info.supportedTokens?.find(
    (x) =>
      originAsset.toLowerCase() === x.address?.toLowerCase() &&
      originChain === x.chainId
  );
}

function isRelayable(
  originChain: ChainId,
  originAsset: string,
  info: RelayerTokenInfo
) {
  if (!originChain || !originAsset || !info) {
    return false;
  }
  const tokenRecord = info.supportedTokens?.find(
    (x) =>
      originAsset.toLowerCase() === x.address?.toLowerCase() &&
      originChain === x.chainId
  );

  return !!(
    tokenRecord &&
    tokenRecord.address &&
    tokenRecord.chainId &&
    tokenRecord.coingeckoId
  );
}

const AVERAGE_ETH_REDEEM_GAS = 100000; //TODO not a great estimate, coordinate this with useTransactionFees hook
const ETH_SAFETY_TOLERANCE = 1.1;

export type RelayerInfo = {
  isRelayable: boolean;
  isRelayingAvailable: boolean;
  feeUsd?: string;
  feeFormatted?: string;
  targetNativeAssetPriceQuote?: number;
};

function calculateFeeUsd(
  comparisonAssetPrice: number,
  targetChain: ChainId,
  gasPrice?: number
) {
  let feeUsd = 0;

  if (targetChain === CHAIN_ID_SOLANA) {
    feeUsd = 1;
  } else if (targetChain === CHAIN_ID_ETH) {
    if (!gasPrice) {
      feeUsd = 0; //catch this error elsewhere
    } else {
      feeUsd =
        ((AVERAGE_ETH_REDEEM_GAS * gasPrice) / 1000000000) *
        comparisonAssetPrice *
        ETH_SAFETY_TOLERANCE;
    }
  } else if (targetChain === CHAIN_ID_TERRA) {
    feeUsd = 5;
  } else if (targetChain === CHAIN_ID_BSC) {
    feeUsd = 5;
  } else if (targetChain === CHAIN_ID_POLYGON) {
    feeUsd = 0.5;
  } else if (targetChain === CHAIN_ID_AVAX) {
    feeUsd = 1;
  } else if (targetChain === CHAIN_ID_OASIS) {
    feeUsd = 1;
  }

  return feeUsd;
}

function fixedUsd(fee: number) {
  return fee.toFixed(2);
}

function requireGasPrice(targetChain: ChainId) {
  return targetChain === CHAIN_ID_ETH;
}

function calculateFeeFormatted(
  feeUsd: number,
  originAssetPrice: number,
  sourceAssetDecimals: number
) {
  return (feeUsd / originAssetPrice).toFixed(sourceAssetDecimals);
}

//This potentially returns the same chain as the foreign chain, in the case where the asset is native
function useRelayerInfo(
  originChain?: ChainId,
  originAsset?: string,
  targetChain?: ChainId
): DataWrapper<RelayerInfo> {
  const [error, setError] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [comparisonAssetPrice, setComparisonAssetPrice] = useState<
    number | null
  >(null);
  const [originAssetPrice, setOriginAssetPrice] = useState<number | null>(null);
  const sourceParsedTokenAccount = useSelector(
    selectTransferSourceParsedTokenAccount
  );
  const sourceAssetDecimals = sourceParsedTokenAccount?.decimals;
  const gasPrice = useSelector(selectTransferGasPrice);
  const relayerInfo = useRelayersAvailable(true);

  const originAssetNative =
    originAsset && originChain
      ? hexToNativeString(originAsset, originChain)
      : null;

  useEffect(() => {
    if (
      !(originAssetNative && originChain && targetChain && relayerInfo.data)
    ) {
      return;
    }

    const relayerAsset = getRelayAssetInfo(
      originChain,
      originAssetNative,
      relayerInfo.data
    );

    //same check as relayable, to satiate typescript.
    if (
      !(
        relayerAsset &&
        relayerAsset.address &&
        relayerAsset.coingeckoId &&
        relayerAsset.chainId
      )
    ) {
      return;
    }

    let cancelled = false;
    setIsLoading(true);
    setError("");

    const promises = [];
    const comparisonAsset = RELAYER_COMPARE_ASSET[targetChain];
    promises.push(
      axios
        .get(getCoinGeckoURL(relayerAsset.coingeckoId))
        .then((result) => {
          if (!cancelled) {
            const value = result.data[relayerAsset.coingeckoId as any][
              "usd"
            ] as number;
            if (!value) {
              setError("Unable to fetch required asset price");
              return;
            }
            setOriginAssetPrice(value);
          }
        })
        .catch((error) => {
          if (!cancelled) {
            setError("Unable to fetch required asset price.");
          }
        })
    );

    promises.push(
      axios
        .get(getCoinGeckoURL(comparisonAsset))
        .then((result) => {
          if (!cancelled) {
            const value = result.data[comparisonAsset]["usd"] as number;
            if (!value) {
              setError("Unable to fetch required asset price");
              return;
            }
            setComparisonAssetPrice(value);
          }
        })
        .catch((error) => {
          if (!cancelled) {
            setError("Unable to fetch required asset price.");
          }
        })
    );

    Promise.all(promises).then(() => {
      setIsLoading(false);
    });

    return () => {
      cancelled = true;
    };
  }, [originAssetNative, originChain, targetChain, relayerInfo.data]);

  const output: DataWrapper<RelayerInfo> = useMemo(() => {
    if (error) {
      return {
        error: error,
        isFetching: false,
        receivedAt: null,
        data: null,
      };
    } else if (isLoading || relayerInfo.isFetching) {
      return {
        error: "",
        isFetching: true,
        receivedAt: null,
        data: null,
      };
    } else if (relayerInfo.error || !relayerInfo.data) {
      return {
        error: "",
        isFetching: false,
        receivedAt: null,
        data: {
          isRelayable: false,
          isRelayingAvailable: false,
          targetNativeAssetPriceQuote: undefined, //TODO can still get this without relayers
        },
      };
    } else if (
      !originChain ||
      !originAssetNative ||
      !targetChain ||
      !sourceAssetDecimals
    ) {
      return {
        error: "Invalid arguments supplied.",
        isFetching: false,
        receivedAt: null,
        data: null,
      };
    } else if (
      !comparisonAssetPrice ||
      !originAssetPrice ||
      (requireGasPrice(targetChain) && !gasPrice)
    ) {
      return {
        error: "Failed to fetch necessary price data.",
        isFetching: false,
        receivedAt: null,
        data: null,
      };
    } else {
      const relayable = isRelayable(
        originChain,
        originAssetNative,
        relayerInfo.data
      );
      const feeUsd = calculateFeeUsd(
        comparisonAssetPrice,
        targetChain,
        gasPrice
      );
      const feeFormatted = calculateFeeFormatted(
        feeUsd,
        originAssetPrice,
        sourceAssetDecimals
      );
      const usdString = fixedUsd(feeUsd);
      return {
        error: "",
        isFetching: false,
        receivedAt: null,
        data: {
          isRelayable: relayable,
          isRelayingAvailable: true,
          feeUsd: usdString,
          feeFormatted: feeFormatted,
          targetNativeAssetPriceQuote: comparisonAssetPrice,
        },
      };
    }
  }, [
    isLoading,
    originChain,
    targetChain,
    error,
    comparisonAssetPrice,
    originAssetPrice,
    gasPrice,
    originAssetNative,
    relayerInfo.data,
    relayerInfo.error,
    relayerInfo.isFetching,
    sourceAssetDecimals,
  ]);

  return output;
}

export default useRelayerInfo;
