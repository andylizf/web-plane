// A host process for checking that the window-suppression dylib actually loads.
//
// DYLD_INSERT_LIBRARIES is silently ignored for a binary that is not ad-hoc
// signed, and a dylib whose constructor never runs injects nothing — both of
// which degrade web-plane into "system Chrome, visible window, no stealth"
// without any error. The dylib's constructor writes the run-id marker named by
// WEB_PLANE_RUN_DIR and WEB_PLANE_RUN_ID, so the caller can check whether the
// injection took.
#include <stdio.h>
#include <unistd.h>

int main(void) {
    printf("%d\n", getpid());
    return 0;
}
