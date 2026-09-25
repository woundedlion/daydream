/** Step table for truncatedIcosahedron_ambo_relax100_truncate01_hk59. */
inline constexpr OpStep
    TRUNCATED_ICOSAHEDRON_AMBO_RELAX100_TRUNCATE01_HK59_STEPS[] = {
        {Op::AMBO},
        {Op::RELAX, 100.0f},
        {Op::TRUNCATE, 0.01f},
        {Op::HANKIN, 59.0f * IslamicStarPatterns::D2R},
};
/**
 * Recipe mirror of
 * IslamicStarPatterns::truncatedIcosahedron_ambo_relax100_truncate01_hk59.
 */
inline constexpr Recipe
    TRUNCATED_ICOSAHEDRON_AMBO_RELAX100_TRUNCATE01_HK59_RECIPE =
        make_recipe(SEED_TRUNCATED_ICOSAHEDRON,
                    TRUNCATED_ICOSAHEDRON_AMBO_RELAX100_TRUNCATE01_HK59_STEPS);

// Append this Entry to islamic_registry and raise ISLAMIC_COUNT by one.
// Until they agree, its size static_assert and the NUM_ENTRIES sum both
// fail; the README registry table counts the entry too.
    {"truncatedIcosahedron_ambo_relax100_truncate01_hk59",
     IslamicStarPatterns::truncatedIcosahedron_ambo_relax100_truncate01_hk59,
     Category::Complex,
     &TRUNCATED_ICOSAHEDRON_AMBO_RELAX100_TRUNCATE01_HK59_RECIPE},
