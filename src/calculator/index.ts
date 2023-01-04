import { isBefore, isEqual } from "date-fns";
import _ from "lodash";
import { ECBConverter } from "../ecbRates";
import { isWithinAWeek, sortChronologicalBy, sortReverseChronologicalBy } from "../util";
import { EAC, Individual } from "./types";

export interface TaxSaleOfSecurity {
    symbol: string,
    quantity: number,
    saleDate: Date,
    purchaseDate: Date,
    salePriceEUR: number,
    saleFeesEUR: number,
    purchasePriceEUR: number,
    purchaseFeesEUR: number,
    deemedAcquisitionCostEUR: number, // hankintameno-olettama
    capitalGainEUR: number,
    capitalLossEUR: number
}

export type StockTransaction = Individual.SellTransaction | Individual.StockPlanActivityTransaction | Individual.SecurityTransferTransaction;

const isStockPlanActivityTransaction = (t: Individual.Transaction): t is Individual.StockPlanActivityTransaction => t.action === Individual.Action.StockPlanActivity;
const isSellTransaction = (t: Individual.Transaction): t is Individual.SellTransaction => t.action === Individual.Action.Sell;
const isSecurityTransferTransaction = (t: Individual.Transaction): t is Individual.SecurityTransferTransaction => t.action === Individual.Action.SecurityTransfer;
const isStockTransaction = (t: Individual.Transaction): t is StockTransaction => isSellTransaction(t) || isStockPlanActivityTransaction(t) || isSecurityTransferTransaction(t);

type OptionSaleTransaction = EAC.ExerciseAndSellTransaction | EAC.SellToCoverTransaction;

const isLapseTransaction = (t: EAC.Transaction): t is EAC.LapseTransaction => t.action === EAC.Action.Lapse;
const isExerciseAndSellTransaction = (t: EAC.Transaction): t is EAC.ExerciseAndSellTransaction => t.action === EAC.Action.ExerciseAndSell;
const isSellToCoverTransaction = (t: EAC.Transaction): t is EAC.SellToCoverTransaction => t.action === EAC.Action.SellToCover;
const isOptionSaleTransaction = (t: EAC.Transaction): t is OptionSaleTransaction => isExerciseAndSellTransaction(t) || isSellToCoverTransaction(t);

const isSellToCoverSellRow = (r: EAC.SellToCoverTransaction['rows'][number]): r is EAC.SellToCoverSellRow => r.action === EAC.SellToCoverAction.Sell;
const isSellToCoverHoldRow = (r: EAC.SellToCoverTransaction['rows'][number]): r is EAC.SellToCoverHoldRow => r.action === EAC.SellToCoverAction.Hold;

/**
 * Filters out all transactions which are not related to moving of stocks
 * 
 * @param individualHistory list of transactions to be filtered
 * @returns a list of transactions with only transactions related to gain or loss of stocks
 */
export function filterStockTransactions(individualHistory: Individual.Transaction[]): StockTransaction[] {
    return individualHistory.filter(isStockTransaction);
}


/**
 * Filters out receiving and selling of shares related to selling options. These transactions
 * do not follow FIFO order and do not need to be considered when calculating capital income.
 * 
 * @param stockTransactions list of stock transactions from individual history
 * @param eacHistory full Equity Awards Center history
 * @returns a list of stock transactions without transactions related to selling of options
 */
export function filterOutOptionSales(stockTransactions: StockTransaction[], eacHistory: EAC.Transaction[]): StockTransaction[] {
    const optionSaleTransactions = eacHistory.filter(isOptionSaleTransaction);
    const filteredTransactions = [...stockTransactions];

    for (const optionSaleTransaction of optionSaleTransactions) {
        // Find gain&sell pairs for the same day
        const gainAndSellPairs = gainAndSellPairsForADay(filteredTransactions, optionSaleTransaction.date);
        const matchingPairs = pairsMatchingToOptionSale(gainAndSellPairs, optionSaleTransaction);
        const flatMatchingPairs: StockTransaction[] = _.flatten(matchingPairs);

        _.remove(filteredTransactions, t => flatMatchingPairs.includes(t));
    }
    return filteredTransactions;
}

type GainAndSell = [Individual.StockPlanActivityTransaction, Individual.SellTransaction];

function gainAndSellPairsForADay(stockTransactions: StockTransaction[], date: Date): GainAndSell[] {
    const gainAndSellPairs: GainAndSell[] = [];
    const transactionsForTheDay = stockTransactions.filter(t => isEqual(t.date, date));
    const gainTransactions = transactionsForTheDay.filter(isStockPlanActivityTransaction);
    const sellTransactions = transactionsForTheDay.filter(isSellTransaction);

    for (const gainTransaction of gainTransactions) {
        const matchingSell = sellTransactions.find(t => gainTransaction.quantity === t.quantity);
        if (matchingSell !== undefined) {
            _.remove(sellTransactions, t => t === matchingSell);
            gainAndSellPairs.push([gainTransaction, matchingSell]);
        }
    }

    return gainAndSellPairs;
}

function pairsMatchingToOptionSale(gainAndSellPairs: GainAndSell[], optionSale: OptionSaleTransaction): GainAndSell[] {
    const exerciseAndSellRows = (optionSale.action === EAC.Action.ExerciseAndSell) ? optionSale.rows : [];
    const sellToCoverRows = (optionSale.action === EAC.Action.SellToCover) ? optionSale.rows.filter(isSellToCoverSellRow): [];
    const unmatchedOptionSaleRows = [...exerciseAndSellRows, ...sellToCoverRows];
    const easPrices = _.uniq(unmatchedOptionSaleRows.map(r => r.salePriceUSD));

    const isValidMatching = (pairs: GainAndSell[], rows: typeof unmatchedOptionSaleRows): boolean => {
        // Total number of shares should match
        if (_.sumBy(pairs, ([g,]) => g.quantity) !== _.sumBy(rows, r => r.sharesExercised)) {
            return false;
        }

        // Each row should match to a single pair, however one pair might have multiple rows
        if (pairs.length > rows.length) {
            return false;
        }

        // TODO: This logic is probably not completely exhaustive
        return true;
    }

    const matchedPairs: GainAndSell[] = [];

    for (const price of easPrices) {
        const easRows = unmatchedOptionSaleRows.filter(r => r.salePriceUSD === price);
        const pairs = gainAndSellPairs.filter(([,sell]) => sell.priceUSD === price);

        const candidates: GainAndSell[][] = [[]];
        for (const pair of pairs) {
            const previousCandidates = [...candidates];
            for (const candidate of previousCandidates) {
                candidates.push([...candidate, pair]);
            }
        }
        console.log({pairs, candidates});

        const validMatch = candidates.find(candidate => isValidMatching(candidate, easRows));
        if (validMatch === undefined) {
            throw new Error(`Couldn't find a matching for Exercise and Sell ${optionSale.date} for salePrice ${price}`);
        }
        console.log('Found matching pairs', validMatch, easRows);
        matchedPairs.push(...validMatch);
    }

    return matchedPairs;
}

export type TransactionWithCostBasis = {
    transaction: Individual.SellTransaction,
    purchaseDate: Date,
    purchasePriceUSD: number,
    quantity: number,
}

export interface Lot {
    symbol: string,
    quantity: number,
    purchaseDate: Date,
    purchasePriceUSD: number,
}

/**
 * Calculates historical lots of shares received. For each lot the function calculates the number of shares
 * received on the date and the purchase price for the shares. Multiple shares received on the same date and
 * purchase price are merged into one lot.
 * 
 * @param stockTransactions list of stock transactions from individual history. See {@link filterStockTransactions}.
 * @param eacHistory full Equity Awards Center history
 * @returns list of Lots
 */
export function buildLots(stockTransactions: StockTransaction[], eacHistory: EAC.Transaction[]): Lot[] {
    const spaTransactions = stockTransactions.filter(isStockPlanActivityTransaction);
    const lots: Lot[] = [];
    for (const spaTransaction of spaTransactions) {
        const lapseTransaction = findLapseTransaction(spaTransaction, eacHistory);
        const sellToCoverTransaction = findSellToCoverTransaction(spaTransaction, eacHistory);
        if (lapseTransaction !== undefined) {
            lots.push({
                symbol: spaTransaction.symbol,
                quantity: spaTransaction.quantity,
                purchaseDate: lapseTransaction.date,
                purchasePriceUSD: lapseTransaction.lapseDetails.fmvUSD,
            })
        }
        else if (sellToCoverTransaction !== undefined) {
            lots.push({
                symbol: spaTransaction.symbol,
                quantity: spaTransaction.quantity,
                purchaseDate: sellToCoverTransaction.date,
                purchasePriceUSD: sellToCoverTransaction.rows.find(isSellToCoverHoldRow)?.awardPriceUSD || 0, // TODO: This is probably not the correct purchase price. We should use the FMV price instead.
            })
        }
        else {
            throw new Error('Could not match Stock Plan Activity to Lapse or Sell To Cover transaction');
        }

    }

    // Merge lots with same date and price
    const mergedLots = lots.reduce((acc: Lot[], lot: Lot) => {
        if (!acc.length) return [lot];
        const prev = acc[acc.length - 1];
        if (isEqual(prev.purchaseDate, lot.purchaseDate) && prev.purchasePriceUSD === lot.purchasePriceUSD) {
            const merged = {...prev, quantity: prev.quantity + lot.quantity};
            return [...acc.slice(0,-1), merged];
        }
        return [...acc, lot];
    }, []);

    return mergedLots;
}

/**
 * Finds the correct Lapse transaction from EAC history which corresponds to the shares gained in
 * spaTransaction.
 * @param spaTransaction transaction for gain of shares in Individual history
 * @param eacHistory full EAC History
 */
function findLapseTransaction(spaTransaction: Individual.StockPlanActivityTransaction, eacHistory: EAC.Transaction[]): EAC.LapseTransaction | undefined {
    const sortedLapseTransactions = eacHistory.filter(isLapseTransaction).sort(sortReverseChronologicalBy(t => t.date));
    
    const isBeforeSPA = (lapseTransaction: EAC.LapseTransaction) => isBefore(lapseTransaction.date, spaTransaction.date);
    const quantityMatchesSPA = (lapseTransaction: EAC.LapseTransaction) =>
        spaTransaction.quantity === lapseTransaction.lapseDetails.sharesDeposited
        || spaTransaction.quantity === lapseTransaction.lapseDetails.sharesSold

    const lapseTransaction = sortedLapseTransactions.find(lt => isBeforeSPA(lt) && quantityMatchesSPA(lt));

    //if (!lapseTransaction) throw new Error('Could not match to lapse');
    return lapseTransaction;
}

function findSellToCoverTransaction(spaTransaction: Individual.StockPlanActivityTransaction, eacHistory: EAC.Transaction[]): EAC.SellToCoverTransaction | undefined {
    const sellToCoverTransactions = eacHistory.filter(isSellToCoverTransaction);

    const isCloseToSPA = (sellToCoverTransaction: EAC.SellToCoverTransaction) => isWithinAWeek(spaTransaction.date, sellToCoverTransaction.date);
    const quantityMatchesSPA = (sellToCoverTransaction: EAC.SellToCoverTransaction) => 
        sellToCoverTransaction.rows.filter(isSellToCoverHoldRow).some(r => r.sharesExercised === spaTransaction.quantity);

    const sellToCoverTransaction = sellToCoverTransactions.find(sct => isCloseToSPA(sct) && quantityMatchesSPA(sct));
    return sellToCoverTransaction;
}

/**
 * Links share losing transactions to the correct lots in order to calculate the correct purchase price.
 * The shares are sold in the First-In First-Out (FIFO) order. In case one lot is not enough to cover for
 * the whole sale transaction the transaction will be split to two parts in the output.
 * 
 * @param stockTransactions list of stock transactions from individual history. See {@link filterStockTransactions}.
 * @param lots list of lots. See {@link buildLots}
 * @returns list of transactions linked with the correct purchase prices. One transaction from input might get
 * split to multiple transactions in the output.
 */
export function calculateCostBases(stockTransactions: StockTransaction[], lots: Lot[]): TransactionWithCostBasis[] {
    const salesTransactions = stockTransactions.filter(isSellTransaction);
    const outboundStockTransferTransactions = stockTransactions.filter(isSecurityTransferTransaction).filter(t => t.quantity < 0);
    const stockForfeitingTransactions = [...salesTransactions, ...outboundStockTransferTransactions];
    const chronologicalTransactions = stockForfeitingTransactions.sort(sortChronologicalBy(t => t.date));

    const chrologicalLots = [...lots].sort(sortChronologicalBy(t => t.purchaseDate));

    const lotIterator = chrologicalLots.values();
    let currentLot: Lot = lotIterator.next().value;
    let sharesSoldFromCurrentLot = 0;

    const results: TransactionWithCostBasis[] = []

    const throwMissingLotError = () => { throw new Error("Couldn't match sell to a lot"); };

    // Outgoing security transfer transactions have negative quantity. We want to use
    // the absolute value instead in order to align the logic with sell transactions
    // which have positive quantity values.
    const absQuantity = (t: StockTransaction) => Math.abs(t.quantity);

    for (const transaction of chronologicalTransactions) {
        if (!currentLot) throwMissingLotError(); // TODO: Log error?
        if (absQuantity(transaction) <= currentLot.quantity - sharesSoldFromCurrentLot) {
            if (isSellTransaction(transaction)) {
                results.push({
                    transaction,
                    purchaseDate: currentLot.purchaseDate,
                    purchasePriceUSD: currentLot.purchasePriceUSD,
                    quantity: transaction.quantity,
                });
            }
            sharesSoldFromCurrentLot += absQuantity(transaction);
        } else {
            let sharesSoldFromPreviousLot = 0;
            if (currentLot.quantity - sharesSoldFromCurrentLot > 0) {
                if (isSellTransaction(transaction)){
                    results.push({
                        transaction,
                        purchaseDate: currentLot.purchaseDate,
                        purchasePriceUSD: currentLot.purchasePriceUSD,
                        quantity: currentLot.quantity - sharesSoldFromCurrentLot,
                    });
                }
                sharesSoldFromPreviousLot = currentLot.quantity - sharesSoldFromCurrentLot;
            }
            currentLot = lotIterator.next().value;
            if(!currentLot) throwMissingLotError();
            sharesSoldFromCurrentLot = 0;
            if (isSellTransaction(transaction)) {
                results.push({
                    transaction,
                    purchaseDate: currentLot.purchaseDate,
                    purchasePriceUSD: currentLot.purchasePriceUSD,
                    quantity: transaction.quantity - sharesSoldFromPreviousLot,
                });
            }
            sharesSoldFromCurrentLot = absQuantity(transaction) - sharesSoldFromPreviousLot;
        }
    }

    return results;
}

/**
 * Builds tax report from the transactions.
 * @param transactionsWithCostBasis list of transactions with correct purchase prices. See {@link calculateCostBases}.
 * @param ecbConverter currency converter
 * @returns list of sale of security tax report rows
 */
export function createTaxReport(transactionsWithCostBasis: TransactionWithCostBasis[], ecbConverter: ECBConverter): TaxSaleOfSecurity[] {
    const chronologicalTransactions = transactionsWithCostBasis.sort(sortChronologicalBy(t => t.transaction.date));

    return chronologicalTransactions.map(transactionWithCostBasis => {
        const quantity = transactionWithCostBasis.quantity;
        const saleDate = transactionWithCostBasis.transaction.date;
        const purchaseDate = transactionWithCostBasis.purchaseDate;
        const salePriceEUR = ecbConverter.usdToEUR(
            transactionWithCostBasis.transaction.priceUSD,
            saleDate
        );
        const saleFeesEUR = transactionWithCostBasis.transaction.feesUSD ?
            ecbConverter.usdToEUR(transactionWithCostBasis.transaction.feesUSD, saleDate)
            :
            0; // TODO: fees getting double counted
        const purchasePriceEUR = ecbConverter.usdToEUR(
            transactionWithCostBasis.purchasePriceUSD,
            purchaseDate
        );
        const purchaseFeesEUR = 0;

        const gainloss = (salePriceEUR * quantity) - (purchasePriceEUR * quantity) - saleFeesEUR - purchaseFeesEUR;
        return {
            symbol: transactionWithCostBasis.transaction.symbol,
            quantity,
            saleDate,
            purchaseDate,
            salePriceEUR,
            saleFeesEUR,
            purchasePriceEUR,
            purchaseFeesEUR,
            deemedAcquisitionCostEUR: 0, // TODO: add support for hankintameno-olettama
            capitalGainEUR: (gainloss > 0) ? gainloss : 0,
            capitalLossEUR: (gainloss < 0) ? -gainloss : 0
        }
    });
}

export function calculateTaxes(
    individualHistory: Individual.Transaction[],
    eacHistory: EAC.Transaction[],
    ecbConverter: ECBConverter
    ): TaxSaleOfSecurity[] {
        // Filter out non-stock transactions
        const stockTransactions = filterStockTransactions(individualHistory);

        const transactionsWithoutOptionSales = filterOutOptionSales(stockTransactions, eacHistory);

        // Build list of lots
        const lots = buildLots(transactionsWithoutOptionSales, eacHistory);

        // Calculate correct cost basis
        const transactionsWithCostBasis = calculateCostBases(transactionsWithoutOptionSales, lots);

        // Create tax report
        const taxReport = createTaxReport(transactionsWithCostBasis, ecbConverter);

        return taxReport;
    }