// clang-format off
/** Step table for dodecahedron_hk62_ambo. */
inline constexpr OpStep DODECAHEDRON_HK62_AMBO_STEPS[] = {
    {Op::HANKIN, 62.0f * IslamicStarPatterns::D2R},
    {Op::AMBO},
};
// clang-format on
/** Authored recipe for dodecahedron_hk62_ambo. */
inline constexpr Recipe DODECAHEDRON_HK62_AMBO_RECIPE =
    make_recipe(SEED_DODECAHEDRON, DODECAHEDRON_HK62_AMBO_STEPS);

// Append this Entry to islamic_registry.
    {"dodecahedron_hk62_ambo", generate_recipe<DODECAHEDRON_HK62_AMBO_RECIPE>,
     Category::COMPLEX, &DODECAHEDRON_HK62_AMBO_RECIPE},
