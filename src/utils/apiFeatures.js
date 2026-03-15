/**
 * APIFeatures — Chainable query builder for Mongoose.
 *
 * Supports: filter → sort → limitFields → paginate
 * Usage:
 *   const features = new APIFeatures(Model.find(scopeFilter), req.query)
 *       .filter().sort().limitFields().paginate();
 *   const docs   = await features.query;
 *   const total  = await features.countTotal(Model, scopeFilter);
 */
class APIFeatures {
    /**
     * @param {mongoose.Query} query       - A Mongoose query object (e.g. Model.find())
     * @param {Object}         queryString - req.query from Express
     */
    constructor(query, queryString) {
        this.query = query;
        this.queryString = queryString;
        this._filterObj = {}; // stored for countTotal()
    }

    /**
     * Applies field-based filtering and advanced operators (gte, gt, lte, lt).
     * Excluded query params: page, sort, limit, fields, includeDeleted.
     */
    filter() {
        const queryObj = { ...this.queryString };
        // 'isArchived' is excluded here — it is handled exclusively via
        // req.archivedFilter set by applyIsArchivedGuard() in controllerUtils.js.
        // Never let apiFeatures touch it, otherwise Mongoose throws a CastError
        // when it tries to cast 'true'/'false'/'all' as a Boolean.
        const excludedFields = ['page', 'sort', 'limit', 'fields', 'includeDeleted', 'isArchived'];
        excludedFields.forEach((el) => delete queryObj[el]);

        // [SECURITY] Only convert explicitly allowed comparison operators.
        // This prevents ?name[$where]=... or ?name[$expr]=... injection.
        // Any other $ prefixed operator passes as a literal string — Mongoose rejects it.
        let queryStr = JSON.stringify(queryObj);
        queryStr = queryStr.replace(/\b(gte|gt|lte|lt)\b/g, (match) => `$${match}`);

        this._filterObj = JSON.parse(queryStr);
        this.query = this.query.find(this._filterObj);

        return this;
    }

    /**
     * Sorts results. Default: newest first (-createdAt).
     * Client usage: ?sort=name,-createdAt
     */
    sort() {
        if (this.queryString.sort) {
            const sortBy = this.queryString.sort.split(',').join(' ');
            this.query = this.query.sort(sortBy);
        } else {
            this.query = this.query.sort('-createdAt');
        }
        return this;
    }

    /**
     * Selects specific fields to return. Default: hides __v.
     * Client usage: ?fields=name,code,college_id
     */
    limitFields() {
        if (this.queryString.fields) {
            const fields = this.queryString.fields.split(',').join(' ');
            this.query = this.query.select(fields);
        } else {
            this.query = this.query.select('-__v');
        }
        return this;
    }

    /**
     * Paginates results. Default: page=1, limit=25.
     * Client usage: ?page=2&limit=10
     */
    paginate() {
        const page  = Math.max(1, this.queryString.page  * 1 || 1);

        // [SECURITY] Cap limit to MAX_LIMIT — prevents DoS via ?limit=999999
        const MAX_LIMIT = 100;
        const requested = this.queryString.limit * 1 || 25;
        const limit = Math.min(requested, MAX_LIMIT);

        const skip  = (page - 1) * limit;

        this.page  = page;
        this.limit = limit;

        this.query = this.query.skip(skip).limit(limit);
        return this;
    }

    /**
     * Returns total matching document count for pagination meta.
     * Must be called AFTER filter() and AFTER the main query is awaited.
     *
     * @param   {mongoose.Model} Model       - The Mongoose model to count on.
     * @param   {Object}         scopeFilter - The collegeAdmin/admin scope filter.
     * @returns {Promise<number>}
     */
    async countTotal(Model, scopeFilter = {}) {
        return Model.countDocuments({ ...scopeFilter, ...this._filterObj });
    }
}

export default APIFeatures;

