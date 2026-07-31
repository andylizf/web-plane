// A host process for checking that the window-suppression dylib actually loads.
//
// DYLD_INSERT_LIBRARIES is silently ignored for a binary that is not ad-hoc
// signed, and a dylib whose constructor never runs injects nothing — both of
// which degrade web-plane into "system Chrome, visible window, no stealth"
// without any error. The dylib's constructor writes /tmp/.chrome-suppress-<pid>,
// so printing this process's pid is enough for the caller to check whether the
// injection took: run this with and without DYLD_INSERT_LIBRARIES and compare.
#include <stdio.h>
#include <unistd.h>

int main(void) {
    printf("%d\n", getpid());
    return 0;
}
