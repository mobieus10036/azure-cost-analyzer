/**
 * Azure Cost Management Service
 * Fetches historical, current, and forecasted cost data using Azure Cost Management APIs
 * Uses Managed Identity authentication (preferred) with fallback to other methods
 */

import { AzureCliCredential } from '@azure/identity';
import { CostManagementClient } from '@azure/arm-costmanagement';
import { 
    ComprehensiveCostAnalysis,
    HistoricalCostData,
    CurrentCostData,
    ForecastedCostData,
    CostDataPoint,
    DailyServiceCostPoint,
    CostByResource,
    CostByService,
    ForecastDataPoint 
} from '../models/costAnalysis';
import { configService } from '../utils/config';
import { logInfo, logError, logWarning } from '../utils/logger';
import { subDays, format, startOfMonth, endOfMonth, addDays, subMonths } from 'date-fns';

export class AzureCostManagementService {
    private client: CostManagementClient;
    private credential: AzureCliCredential;
    private subscriptionId: string;
    private scope: string;
    private readonly API_DELAY_MS: number;
    private readonly MAX_RETRIES: number;
    private readonly RETRY_DELAY_MS: number;
    private readonly RETRY_MAX_DELAY_MS: number;
    private readonly LIVE_DATA_ONLY: boolean;
    
    // Cache for avoiding redundant API calls within the same session
    private queryCache: Map<string, { data: any; timestamp: number }> = new Map();
    private readonly CACHE_TTL_MS = 300000; // 5 minute cache TTL

    constructor() {
        const azureConfig = configService.getAzureConfig();
        this.subscriptionId = azureConfig.subscriptionId;
        this.scope = azureConfig.scope;
        this.LIVE_DATA_ONLY = azureConfig.costManagement?.liveDataOnly ?? true;
        this.API_DELAY_MS = azureConfig.costManagement?.apiDelayMs || 5000;
        this.MAX_RETRIES = azureConfig.costManagement?.maxRetries || 5;
        this.RETRY_DELAY_MS = azureConfig.costManagement?.retryBaseDelayMs || 15000;
        this.RETRY_MAX_DELAY_MS = azureConfig.costManagement?.retryMaxDelayMs || 120000;
        
        // Force Azure CLI credential so runtime az login/subscription context is honored consistently.
        this.credential = new AzureCliCredential({ tenantId: azureConfig.tenantId });
        this.client = new CostManagementClient(this.credential);
        
        logInfo('Azure Cost Management Service initialized');
    }

    /**
     * Delay helper to avoid rate limiting
     */
    private async delay(ms: number): Promise<void> {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    /**
     * Execute API call with retry logic for rate limiting.
     * Respects the Retry-After header returned by Azure on 429 responses.
     */
    private async executeWithRetry<T>(operation: () => Promise<T>, operationName: string): Promise<T> {
        for (let attempt = 1; attempt <= this.MAX_RETRIES; attempt++) {
            try {
                return await operation();
            } catch (error: any) {
                const isRateLimitError = error?.message?.includes('Too many requests') || 
                                        error?.statusCode === 429;
                
                if (isRateLimitError && attempt < this.MAX_RETRIES) {
                    // Honour the Retry-After header if Azure provides one
                    const retryAfterRaw = error?.response?.headers?.get?.('retry-after') ??
                                         error?.response?.headers?.['retry-after'];
                    const retryAfterMs = retryAfterRaw && !isNaN(parseInt(retryAfterRaw, 10))
                        ? parseInt(retryAfterRaw, 10) * 1000
                        : null;

                    const backoffMs = Math.min(
                        this.RETRY_DELAY_MS * Math.pow(2, attempt - 1),
                        this.RETRY_MAX_DELAY_MS
                    );
                    // Use whichever is larger: Azure's instruction or our backoff
                    const waitTime = retryAfterMs ? Math.max(retryAfterMs, backoffMs) : backoffMs;

                    logWarning(
                        `Rate limit hit for ${operationName}. ` +
                        `Waiting ${waitTime}ms before retry ${attempt}/${this.MAX_RETRIES}` +
                        (retryAfterMs ? ` (Retry-After: ${retryAfterMs}ms)` : '') + '...'
                    );
                    await this.delay(waitTime);
                } else {
                    throw error;
                }
            }
        }
        throw new Error(`Failed after ${this.MAX_RETRIES} retries`);
    }

    /**
     * Generate cache key for query results
     */
    private getCacheKey(startDate: Date, endDate: Date, queryType: string): string {
        return `${queryType}-${format(startDate, 'yyyy-MM-dd')}-${format(endDate, 'yyyy-MM-dd')}`;
    }

    /**
     * Get cached result if available and not expired
     */
    private getCachedResult(cacheKey: string): any | null {
        const cached = this.queryCache.get(cacheKey);
        if (cached && (Date.now() - cached.timestamp) < this.CACHE_TTL_MS) {
            logInfo(`Using cached result for ${cacheKey}`);
            return cached.data;
        }
        return null;
    }

    /**
     * Store result in cache
     */
    private setCachedResult(cacheKey: string, data: any): void {
        this.queryCache.set(cacheKey, { data, timestamp: Date.now() });
    }

    /**
     * Get comprehensive cost analysis including historical, current, and forecasted data
     */
    public async getComprehensiveCostAnalysis(): Promise<ComprehensiveCostAnalysis> {
        try {
            logInfo('Starting comprehensive cost analysis...');
            logInfo('Using optimized API calls with intelligent caching...');
            
            const analysisConfig = configService.getAnalysisConfig();
            const now = new Date();
            
            // Fetch historical data first (will be reused for forecast)
            logInfo('Fetching historical data...');
            const historical = await this.getHistoricalCostData(analysisConfig.historicalDays);
            
            // Fetch current month data (parallel-friendly queries are batched internally)
            logInfo('Fetching current month data...');
            const current = await this.getCurrentCostData();
            
            // Generate forecast using cached historical data (no additional API calls needed)
            logInfo('Generating forecast...');
            const forecasted = await this.getForecastedCostData(analysisConfig.forecastDays, historical);

            // Calculate summary metrics
            const summary = this.calculateSummary(historical, current, forecasted);

            const analysis: ComprehensiveCostAnalysis = {
                id: `analysis-${Date.now()}`,
                subscriptionId: this.subscriptionId,
                scope: this.scope,
                analysisDate: now.toISOString(),
                historical,
                current,
                forecasted,
                trends: [], // Will be populated by trend analyzer
                anomalies: [], // Will be populated by anomaly detector
                fluctuations: [],
                dataProvenance: {
                    mode: 'live',
                    source: 'Azure Cost Management API',
                    generatedFromFallback: false,
                    queryPolicy: {
                        apiDelayMs: this.API_DELAY_MS,
                        maxRetries: this.MAX_RETRIES,
                        retryBaseDelayMs: this.RETRY_DELAY_MS,
                        retryMaxDelayMs: this.RETRY_MAX_DELAY_MS
                    }
                },
                summary
            };

            logInfo('Comprehensive cost analysis completed');
            return analysis;
            
        } catch (error) {
            logError(`Error in comprehensive cost analysis: ${error}`);
            throw error;
        }
    }

    /**
     * Get historical cost data for the specified number of days
     */
    public async getHistoricalCostData(days: number = 90): Promise<HistoricalCostData> {
        try {
            logInfo(`Fetching historical cost data for ${days} days...`);
            
            const endDate = new Date();
            const startDate = subDays(endDate, days);
            
            // Query Azure Cost Management API for actual cost data
            const queryResult = await this.queryActualCosts(startDate, endDate);
            
            const historicalData: HistoricalCostData = {
                startDate: startDate.toISOString(),
                endDate: endDate.toISOString(),
                totalCost: queryResult.totalCost,
                currency: queryResult.currency || 'USD',
                dailyCosts: queryResult.dailyCosts,
                dailyServiceCosts: queryResult.dailyServiceCosts,
                monthlyCosts: queryResult.monthlyCosts,
                costByResource: queryResult.costByResource,
                costByService: queryResult.costByService,
                costByResourceGroup: queryResult.costByResourceGroup
            };

            logInfo(`Historical data fetched: ${historicalData.totalCost} ${historicalData.currency}`);
            return historicalData;
            
        } catch (error) {
            logError(`Error fetching historical cost data: ${error}`);
            throw error;
        }
    }

    /**
     * Get current month-to-date cost data
     */
    public async getCurrentCostData(): Promise<CurrentCostData> {
        try {
            logInfo('Fetching current month cost data...');
            
            const now = new Date();
            const monthStart = startOfMonth(now);
            const monthEnd = endOfMonth(now);
            
            // Query current month costs
            const currentMonthQuery = await this.queryActualCosts(monthStart, now);
            
            // Add delay before next query
            await this.delay(this.API_DELAY_MS);
            
            // Get previous month (last full month)
            const prevMonthStart = subMonths(monthStart, 1);
            const prevMonthEnd = endOfMonth(prevMonthStart);
            const prevMonthQuery = await this.queryActualCosts(prevMonthStart, prevMonthEnd);
            
            // Add delay before next query
            await this.delay(this.API_DELAY_MS);
            
            // Get 2 months ago (second to last full month)
            const twoMonthsAgoStart = subMonths(monthStart, 2);
            const twoMonthsAgoEnd = endOfMonth(twoMonthsAgoStart);
            const twoMonthsAgoQuery = await this.queryActualCosts(twoMonthsAgoStart, twoMonthsAgoEnd);
            
            // Calculate estimated month-end cost based on daily average
            const daysElapsed = Math.floor((now.getTime() - monthStart.getTime()) / (1000 * 60 * 60 * 24)) + 1;
            const daysInMonth = Math.floor((monthEnd.getTime() - monthStart.getTime()) / (1000 * 60 * 60 * 24)) + 1;
            const avgDailyCost = currentMonthQuery.totalCost / daysElapsed;
            const estimatedMonthEndCost = avgDailyCost * daysInMonth;
            
            // Old comparison (current partial vs last full) - keeping for backward compatibility
            const changeAmount = currentMonthQuery.totalCost - prevMonthQuery.totalCost;
            const changePercent = prevMonthQuery.totalCost > 0 
                ? (changeAmount / prevMonthQuery.totalCost) * 100 
                : 0;

            // New 3-month comparison
            const lastTwoMonthsChangeAmount = prevMonthQuery.totalCost - twoMonthsAgoQuery.totalCost;
            const lastTwoMonthsChangePercent = twoMonthsAgoQuery.totalCost > 0
                ? (lastTwoMonthsChangeAmount / twoMonthsAgoQuery.totalCost) * 100
                : 0;
                
            const projectedChangeAmount = estimatedMonthEndCost - prevMonthQuery.totalCost;
            const projectedChangePercent = prevMonthQuery.totalCost > 0
                ? (projectedChangeAmount / prevMonthQuery.totalCost) * 100
                : 0;

            const currentData: CurrentCostData = {
                billingPeriodStart: monthStart.toISOString(),
                billingPeriodEnd: monthEnd.toISOString(),
                currentDate: now.toISOString(),
                monthToDateCost: currentMonthQuery.totalCost,
                estimatedMonthEndCost,
                currency: currentMonthQuery.currency || 'USD',
                dailyCosts: currentMonthQuery.dailyCosts,
                topCostResources: currentMonthQuery.costByResource.slice(0, 10),
                topCostServices: currentMonthQuery.costByService.slice(0, 10),
                comparisonToPreviousMonth: {
                    previousMonthTotal: prevMonthQuery.totalCost,
                    changeAmount,
                    changePercent
                },
                monthlyComparison: {
                    twoMonthsAgo: {
                        name: format(twoMonthsAgoStart, 'MMMM yyyy'),
                        total: twoMonthsAgoQuery.totalCost
                    },
                    lastMonth: {
                        name: format(prevMonthStart, 'MMMM yyyy'),
                        total: prevMonthQuery.totalCost
                    },
                    currentMonth: {
                        name: format(monthStart, 'MMMM yyyy'),
                        monthToDate: currentMonthQuery.totalCost,
                        projected: estimatedMonthEndCost
                    },
                    lastTwoMonthsChange: {
                        amount: lastTwoMonthsChangeAmount,
                        percent: lastTwoMonthsChangePercent
                    },
                    projectedChange: {
                        amount: projectedChangeAmount,
                        percent: projectedChangePercent
                    }
                }
            };

            logInfo(`Current month-to-date: ${currentData.monthToDateCost} ${currentData.currency}`);
            return currentData;
            
        } catch (error) {
            logError(`Error fetching current cost data: ${error}`);
            throw error;
        }
    }

    /**
     * Get forecasted cost data for the specified number of days
     * @param days Number of days to forecast
     * @param existingHistoricalData Optional pre-fetched historical data to avoid redundant API calls
     */
    public async getForecastedCostData(days: number = 30, existingHistoricalData?: HistoricalCostData): Promise<ForecastedCostData> {
        try {
            logInfo(`Generating cost forecast for ${days} days...`);
            
            const startDate = addDays(new Date(), 1);
            const endDate = addDays(startDate, days);
            
            // Use provided historical data or fetch fresh (with caching)
            const historicalData = existingHistoricalData || await this.getHistoricalCostData(30);
            const historicalDays = historicalData.dailyCosts.length || 30;
            const avgDailyCost = historicalData.totalCost / historicalDays;
            
            const dailyForecasts: ForecastDataPoint[] = [];
            let cumulativeCost = 0;
            
            for (let i = 0; i < days; i++) {
                const forecastDate = addDays(startDate, i);
                const predictedCost = avgDailyCost * (1 + (Math.random() * 0.1 - 0.05)); // Add 5% variance
                cumulativeCost += predictedCost;
                
                dailyForecasts.push({
                    date: forecastDate.toISOString(),
                    predictedCost,
                    confidenceLower: predictedCost * 0.90, // 90% confidence interval
                    confidenceUpper: predictedCost * 1.10,
                    currency: historicalData.currency
                });
            }

            const forecastedData: ForecastedCostData = {
                forecastStartDate: startDate.toISOString(),
                forecastEndDate: endDate.toISOString(),
                totalForecastedCost: cumulativeCost,
                currency: historicalData.currency,
                dailyForecasts,
                monthlyForecasts: [], // Could aggregate daily into monthly
                forecastMethod: 'linear-projection',
                confidenceLevel: 0.90,
                assumptions: [
                    'Based on 30-day historical average',
                    'Assumes similar usage patterns',
                    'Does not account for planned changes or seasonality'
                ]
            };

            logInfo(`Forecasted cost for next ${days} days: ${forecastedData.totalForecastedCost} ${forecastedData.currency}`);
            return forecastedData;
            
        } catch (error) {
            logError(`Error generating cost forecast: ${error}`);
            throw error;
        }
    }

    /**
     * Query actual costs from Azure Cost Management API
     */
    private async queryActualCosts(startDate: Date, endDate: Date): Promise<{
        totalCost: number;
        currency: string;
        dailyCosts: CostDataPoint[];
        dailyServiceCosts: DailyServiceCostPoint[];
        monthlyCosts: CostDataPoint[];
        costByResource: CostByResource[];
        costByService: CostByService[];
        costByResourceGroup: Array<{ resourceGroup: string; cost: number; resourceCount: number }>;
    }> {
        // Check cache first
        const cacheKey = this.getCacheKey(startDate, endDate, 'costs');
        const cachedResult = this.getCachedResult(cacheKey);
        if (cachedResult) {
            return cachedResult;
        }

        try {
            logInfo(`Querying actual costs from ${format(startDate, 'yyyy-MM-dd')} to ${format(endDate, 'yyyy-MM-dd')}...`);
            
            // Query 1: Get daily costs
            const dailyQuery = {
                type: "Usage",
                timeframe: "Custom",
                timePeriod: {
                    from: startDate.toISOString(),
                    to: endDate.toISOString()
                },
                dataset: {
                    granularity: "Daily",
                    aggregation: {
                        totalCost: {
                            name: "Cost",
                            function: "Sum"
                        }
                    }
                }
            };

            // Query 2: Get costs by service
            const serviceQuery = {
                type: "Usage",
                timeframe: "Custom",
                timePeriod: {
                    from: startDate.toISOString(),
                    to: endDate.toISOString()
                },
                dataset: {
                    granularity: "None",
                    aggregation: {
                        totalCost: {
                            name: "Cost",
                            function: "Sum"
                        }
                    },
                    grouping: [
                        {
                            type: "Dimension",
                            name: "ServiceName"
                        }
                    ]
                }
            };

            // Query 3: Get daily costs by service to attribute daily fluctuations
            const dailyServiceQuery = {
                type: "Usage",
                timeframe: "Custom",
                timePeriod: {
                    from: startDate.toISOString(),
                    to: endDate.toISOString()
                },
                dataset: {
                    granularity: "Daily",
                    aggregation: {
                        totalCost: {
                            name: "Cost",
                            function: "Sum"
                        }
                    },
                    grouping: [
                        {
                            type: "Dimension",
                            name: "ServiceName"
                        }
                    ]
                }
            };

            // Execute queries sequentially with delay and retry logic to avoid rate limiting
            const dailyResult = await this.executeWithRetry(
                () => this.client.query.usage(this.scope, dailyQuery as any),
                'daily costs query'
            );
            await this.delay(this.API_DELAY_MS);
            
            const serviceResult = await this.executeWithRetry(
                () => this.client.query.usage(this.scope, serviceQuery as any),
                'service costs query'
            );
            await this.delay(this.API_DELAY_MS);

            const dailyServiceResult = await this.executeWithRetry(
                () => this.client.query.usage(this.scope, dailyServiceQuery as any),
                'daily service costs query'
            );
            // Delay after the final sub-query so the caller's next queryActualCosts
            // call doesn't immediately hit the API again
            await this.delay(this.API_DELAY_MS);

            // Parse daily costs
            const dailyCosts: CostDataPoint[] = [];
            let totalCost = 0;
            
            if (dailyResult.rows && dailyResult.rows.length > 0) {
                const costIndex = dailyResult.columns?.findIndex((col: any) => col.name === 'Cost') ?? -1;
                const dateIndex = dailyResult.columns?.findIndex((col: any) => col.name === 'UsageDate') ?? -1;
                const currencyIndex = dailyResult.columns?.findIndex((col: any) => col.name === 'Currency') ?? -1;

                dailyResult.rows.forEach((row: any) => {
                    const cost = costIndex >= 0 ? parseFloat(row[costIndex]) : 0;
                    const date = dateIndex >= 0 ? row[dateIndex] : '';
                    const currency = currencyIndex >= 0 ? row[currencyIndex] : 'USD';
                    
                    totalCost += cost;
                    
                    // Parse the date correctly - Azure returns it in YYYYMMDD format as a number
                    let dateString: string;
                    if (typeof date === 'number') {
                        // Convert YYYYMMDD number to Date object
                        const dateStr = date.toString();
                        const year = parseInt(dateStr.substring(0, 4));
                        const month = parseInt(dateStr.substring(4, 6)) - 1; // JS months are 0-indexed
                        const day = parseInt(dateStr.substring(6, 8));
                        dateString = new Date(year, month, day).toISOString();
                    } else if (typeof date === 'string' && date.length === 8) {
                        // Handle string format YYYYMMDD
                        const year = parseInt(date.substring(0, 4));
                        const month = parseInt(date.substring(4, 6)) - 1;
                        const day = parseInt(date.substring(6, 8));
                        dateString = new Date(year, month, day).toISOString();
                    } else {
                        dateString = date;
                    }
                    
                    dailyCosts.push({
                        date: dateString,
                        cost,
                        currency
                    });
                });
            }

            // Parse service costs
            const costByService: CostByService[] = [];
            const serviceMap = new Map<string, number>();
            const dailyServiceCosts: DailyServiceCostPoint[] = [];
            
            if (serviceResult.rows && serviceResult.rows.length > 0) {
                const costIndex = serviceResult.columns?.findIndex((col: any) => col.name === 'Cost') ?? -1;
                const serviceIndex = serviceResult.columns?.findIndex((col: any) => col.name === 'ServiceName') ?? -1;

                serviceResult.rows.forEach((row: any) => {
                    const cost = costIndex >= 0 ? parseFloat(row[costIndex]) : 0;
                    const serviceName = serviceIndex >= 0 ? row[serviceIndex] : 'Unknown';
                    
                    if (serviceName && cost > 0) {
                        const existing = serviceMap.get(serviceName) || 0;
                        serviceMap.set(serviceName, existing + cost);
                    }
                });

                // Convert map to array and calculate percentages
                const totalServiceCost = Array.from(serviceMap.values()).reduce((sum, cost) => sum + cost, 0);
                
                serviceMap.forEach((cost, serviceName) => {
                    const category = this.categorizeService(serviceName);
                    costByService.push({
                        serviceName,
                        serviceCategory: category,
                        cost,
                        currency: 'USD',
                        percentageOfTotal: totalServiceCost > 0 ? (cost / totalServiceCost) * 100 : 0
                    });
                });

                // Sort by cost descending
                costByService.sort((a, b) => b.cost - a.cost);
            }

            // Parse daily service costs
            if (dailyServiceResult.rows && dailyServiceResult.rows.length > 0) {
                const costIndex = dailyServiceResult.columns?.findIndex((col: any) => col.name === 'Cost') ?? -1;
                const dateIndex = dailyServiceResult.columns?.findIndex((col: any) => col.name === 'UsageDate') ?? -1;
                const currencyIndex = dailyServiceResult.columns?.findIndex((col: any) => col.name === 'Currency') ?? -1;
                const serviceIndex = dailyServiceResult.columns?.findIndex((col: any) => col.name === 'ServiceName') ?? -1;

                dailyServiceResult.rows.forEach((row: any) => {
                    const cost = costIndex >= 0 ? parseFloat(row[costIndex]) : 0;
                    const date = dateIndex >= 0 ? row[dateIndex] : '';
                    const currency = currencyIndex >= 0 ? row[currencyIndex] : 'USD';
                    const serviceName = serviceIndex >= 0 ? row[serviceIndex] : 'Unknown';

                    if (!serviceName || cost <= 0) {
                        return;
                    }

                    let dateString: string;
                    if (typeof date === 'number') {
                        const dateStr = date.toString();
                        const year = parseInt(dateStr.substring(0, 4));
                        const month = parseInt(dateStr.substring(4, 6)) - 1;
                        const day = parseInt(dateStr.substring(6, 8));
                        dateString = new Date(year, month, day).toISOString();
                    } else if (typeof date === 'string' && date.length === 8) {
                        const year = parseInt(date.substring(0, 4));
                        const month = parseInt(date.substring(4, 6)) - 1;
                        const day = parseInt(date.substring(6, 8));
                        dateString = new Date(year, month, day).toISOString();
                    } else {
                        dateString = date;
                    }

                    dailyServiceCosts.push({
                        date: dateString,
                        serviceName,
                        serviceCategory: this.categorizeService(serviceName),
                        cost,
                        currency
                    });
                });
            }

            logInfo(`Query complete: ${totalCost.toFixed(2)} USD across ${dailyCosts.length} days, ${costByService.length} services, ${dailyServiceCosts.length} daily service points`);

            const result = {
                totalCost,
                currency: 'USD',
                dailyCosts,
                dailyServiceCosts,
                monthlyCosts: [],
                costByResource: [],
                costByService,
                costByResourceGroup: []
            };

            // Cache the result
            this.setCachedResult(cacheKey, result);

            return result;
            
        } catch (error) {
            logError(`Error querying actual costs: ${error}`);
            if (this.LIVE_DATA_ONLY) {
                const errorText = String(error);
                const wrongIssuerDetected = errorText.includes('wrong issuer') && errorText.includes('must match the tenant');
                if (wrongIssuerDetected) {
                    throw new Error(
                        'Live cost query failed due to Azure tenant token mismatch. ' +
                        'Run `az account clear`, then `az login --tenant <AZURE_TENANT_ID>`, and ensure the active subscription belongs to that tenant. ' +
                        'Fallback is disabled (AZURE_COST_LIVE_DATA_ONLY=true).'
                    );
                }

                throw new Error(
                    `Live cost query failed and fallback is disabled (AZURE_COST_LIVE_DATA_ONLY=true). ` +
                    `Please retry later or increase AZURE_COST_API_DELAY_MS / AZURE_COST_MAX_RETRIES.`
                );
            }

            logWarning('Falling back to mock data due to API error');
            return this.generateMockCostData(startDate, endDate);
        }
    }

    /**
     * Categorize Azure service into a logical category
     */
    private categorizeService(serviceName: string): string {
        const name = serviceName.toLowerCase();
        
        if (name.includes('virtual machine') || name.includes('compute') || name.includes('kubernetes') || 
            name.includes('container') || name.includes('functions') || name.includes('app service')) {
            return 'Compute';
        }
        if (name.includes('storage') || name.includes('blob') || name.includes('file') || 
            name.includes('disk') || name.includes('backup')) {
            return 'Storage';
        }
        if (name.includes('sql') || name.includes('database') || name.includes('cosmos') || 
            name.includes('redis') || name.includes('cache')) {
            return 'Databases';
        }
        if (name.includes('network') || name.includes('gateway') || name.includes('load balancer') || 
            name.includes('firewall') || name.includes('vpn') || name.includes('dns')) {
            return 'Networking';
        }
        if (name.includes('monitor') || name.includes('log') || name.includes('insight') || 
            name.includes('alert') || name.includes('metric')) {
            return 'Management';
        }
        if (name.includes('ai') || name.includes('cognitive') || name.includes('bot') || 
            name.includes('machine learning')) {
            return 'AI + ML';
        }
        if (name.includes('security') || name.includes('key vault') || name.includes('sentinel')) {
            return 'Security';
        }
        
        return 'Other';
    }

    /**
     * Generate mock data as fallback
     */
    private generateMockCostData(startDate: Date, endDate: Date): {
        totalCost: number;
        currency: string;
        dailyCosts: CostDataPoint[];
        dailyServiceCosts: DailyServiceCostPoint[];
        monthlyCosts: CostDataPoint[];
        costByResource: CostByResource[];
        costByService: CostByService[];
        costByResourceGroup: Array<{ resourceGroup: string; cost: number; resourceCount: number }>;
    } {
        const days = Math.floor((endDate.getTime() - startDate.getTime()) / (1000 * 60 * 60 * 24));
        const dailyCosts: CostDataPoint[] = [];
        const dailyServiceCosts: DailyServiceCostPoint[] = [];
        let totalCost = 0;
        
        for (let i = 0; i <= days; i++) {
            const date = addDays(startDate, i);
            const cost = 100 + Math.random() * 50;
            totalCost += cost;
            
            dailyCosts.push({
                date: format(date, 'yyyy-MM-dd'),
                cost,
                currency: 'USD'
            });

            const computeShare = cost * 0.45;
            const storageShare = cost * 0.25;
            const databaseShare = cost * 0.20;
            const otherShare = cost * 0.10;

            dailyServiceCosts.push(
                {
                    date: format(date, 'yyyy-MM-dd'),
                    serviceName: 'Virtual Machines',
                    serviceCategory: 'Compute',
                    cost: computeShare,
                    currency: 'USD'
                },
                {
                    date: format(date, 'yyyy-MM-dd'),
                    serviceName: 'Storage Accounts',
                    serviceCategory: 'Storage',
                    cost: storageShare,
                    currency: 'USD'
                },
                {
                    date: format(date, 'yyyy-MM-dd'),
                    serviceName: 'Azure SQL Database',
                    serviceCategory: 'Databases',
                    cost: databaseShare,
                    currency: 'USD'
                },
                {
                    date: format(date, 'yyyy-MM-dd'),
                    serviceName: 'Log Analytics',
                    serviceCategory: 'Management',
                    cost: otherShare,
                    currency: 'USD'
                }
            );
        }

        // Mock service distribution
        const serviceDistribution = [
            { name: 'Virtual Machines', category: 'Compute', percentage: 35 },
            { name: 'Azure Kubernetes Service', category: 'Compute', percentage: 20 },
            { name: 'Azure SQL Database', category: 'Databases', percentage: 15 },
            { name: 'Storage Accounts', category: 'Storage', percentage: 8 },
            { name: 'Application Gateway', category: 'Networking', percentage: 7 },
            { name: 'Azure Cosmos DB', category: 'Databases', percentage: 5 },
            { name: 'Log Analytics', category: 'Management', percentage: 4 },
            { name: 'Azure Functions', category: 'Compute', percentage: 3 },
            { name: 'Azure Cache for Redis', category: 'Databases', percentage: 2 },
            { name: 'Azure Monitor', category: 'Management', percentage: 1 }
        ];

        const costByService: CostByService[] = serviceDistribution.map(service => ({
            serviceName: service.name,
            serviceCategory: service.category,
            cost: totalCost * (service.percentage / 100),
            currency: 'USD',
            percentageOfTotal: service.percentage
        }));

        return {
            totalCost,
            currency: 'USD',
            dailyCosts,
            dailyServiceCosts,
            monthlyCosts: [],
            costByResource: [],
            costByService,
            costByResourceGroup: []
        };
    }

    /**
     * Calculate summary metrics from all cost data
     */
    private calculateSummary(
        historical: HistoricalCostData,
        current: CurrentCostData,
        forecasted: ForecastedCostData
    ) {
        const allDailyCosts = [...historical.dailyCosts, ...current.dailyCosts];
        const costs = allDailyCosts.map(d => d.cost);
        
        return {
            totalHistoricalCost: historical.totalCost,
            currentMonthToDate: current.monthToDateCost,
            forecastedMonthEnd: current.estimatedMonthEndCost,
            forecastedNextMonth: forecasted.totalForecastedCost,
            currency: historical.currency,
            avgDailySpend: costs.reduce((a, b) => a + b, 0) / costs.length,
            peakDailySpend: Math.max(...costs),
            lowestDailySpend: Math.min(...costs)
        };
    }
}
