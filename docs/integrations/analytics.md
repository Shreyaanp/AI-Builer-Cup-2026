# GA4 setup

1. Open [Google Analytics](https://analytics.google.com/) with the account that owns the Chalkboard sites.
2. Create an account or property for Chalkboard. Set the reporting time zone and currency to the business's reporting needs.
3. In **Admin → Data streams**, add a **Web** stream for `https://chalkboard.shreyaan.work`.
4. Add a second **Web** stream for `https://business.chalkboard.shreyaan.work`.
5. Copy the Measurement ID (`G-…`) for the stream you want to use and set backend runtime configuration `GA_MEASUREMENT_ID` to that ID (for the checked release workflow, set the optional GitHub Actions repository variable with the same name). The default is empty, which keeps analytics disabled. Restart/release the app after changing runtime configuration.

When either stream has activity, open **Reports → Realtime** in the same GA4 property to see active users and events from the last 30 minutes. Use the stream selector to inspect each host. `app` and `region` are the only user properties. Analytics loads only after the app's first-open legal consent; advertising storage and advertising data remain denied.

Events contain no names, phone numbers, messages, voice, photos, or shop names. Shop metadata is limited to a broad kind and `IN`/`SG` region. Do not add personal or merchant-identifying values to analytics events.

The current first-open consent record exists for owners. The customer app does not yet collect a corresponding legal consent, so customer event calls remain disabled until that consent flow exists.
