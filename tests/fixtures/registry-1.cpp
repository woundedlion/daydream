/** Step table for dodecahedron_hk62_ambo. */
inline constexpr OpStep DODECAHEDRON_HK62_AMBO_STEPS[] = {
    {Op::HANKIN, 62.0f * IslamicStarPatterns::D2R},
    {Op::AMBO},
};
/** Recipe mirror of IslamicStarPatterns::dodecahedron_hk62_ambo. */
inline constexpr Recipe DODECAHEDRON_HK62_AMBO_RECIPE =
    make_recipe(SEED_DODECAHEDRON, DODECAHEDRON_HK62_AMBO_STEPS);

// Append this Entry to islamic_registry and raise ISLAMIC_COUNT by one.
// Until they agree, its size static_assert and the NUM_ENTRIES sum both
// fail; the README registry table counts the entry too.
    {"dodecahedron_hk62_ambo", IslamicStarPatterns::dodecahedron_hk62_ambo,
     Category::Complex, &DODECAHEDRON_HK62_AMBO_RECIPE},
