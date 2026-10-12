package ee.forgr.capacitor_inappbrowser;

import org.junit.Test;
import static org.junit.Assert.*;

public class BreadPresentationStateTest {
    private BreadPresentationState ready() {
        BreadPresentationState state = new BreadPresentationState(30000);
        state.navigate(0);
        state.configure("doc", true, true);
        state.ready();
        return state;
    }

    @Test public void navigationInvalidatesOldPaintAndDocumentAuthority() {
        BreadPresentationState state = ready();
        long old = state.generation();
        assertTrue(state.authorizes(true, "doc", "doc", state.navigationGeneration()));
        long oldNavigation = state.navigationGeneration();
        state.navigate(10);
        assertFalse(state.canReveal(old));
        assertFalse(state.authorizes(true, "doc", "doc", oldNavigation));
        assertFalse(state.isReady());
    }

    @Test public void actualMainFrameAndCurrentTokenAreRequiredEvenWhenHidden() {
        BreadPresentationState state = ready();
        long generation = state.navigationGeneration();
        assertFalse(state.authorizes(false, "doc", "doc", generation));
        assertFalse(state.authorizes(true, "old", "doc", generation));
        assertFalse(state.authorizes(true, "", "", generation));
        state.visibility(false, 20);
        assertTrue(state.authorizes(true, "doc", "doc", state.navigationGeneration()));
        assertFalse(state.canReveal(state.generation()));
    }

    @Test public void hideResumeAndRotationRequireFreshPaint() {
        BreadPresentationState state = ready();
        long first = state.generation();
        state.visibility(false, 10);
        state.visibility(true, 20);
        assertFalse(state.canReveal(first));
        assertTrue(state.canReveal(state.generation()));
        long resumed = state.generation();
        state.layoutChanged();
        assertFalse(state.canReveal(resumed));
        assertTrue(state.canReveal(state.generation()));
    }

    @Test public void closedStateCannotBeRestoredAndCloseOccursOnce() {
        BreadPresentationState state = ready();
        assertTrue(state.close());
        assertFalse(state.close());
        state.visibility(true, 30);
        state.foreground(true, 30);
        state.ready();
        assertFalse(state.canReveal(state.generation()));
        assertFalse(state.authorizes(true, "doc", "doc", state.navigationGeneration()));
    }

    @Test public void timeoutCountsOnlyRequestedVisibleForegroundTime() {
        BreadPresentationState state = new BreadPresentationState(30000);
        state.navigate(0);
        state.foreground(false, 10000);
        assertFalse(state.tick(100000));
        state.foreground(true, 100000);
        assertFalse(state.tick(119999));
        assertTrue(state.tick(120000));
        state.ready();
        assertFalse(state.canReveal(state.generation()));
    }

    @Test public void parkedTimeoutAndNavigationReset() {
        BreadPresentationState state = new BreadPresentationState(30000);
        state.navigate(0);
        state.visibility(false, 10000);
        assertFalse(state.tick(100000));
        state.visibility(true, 100000);
        assertTrue(state.tick(120000));
        state.navigate(120000);
        assertFalse(state.tick(149999));
    }

    @Test public void configurationAloneNeverRevealsBeforeDocumentReady() {
        BreadPresentationState state = new BreadPresentationState(30000);
        state.navigate(0);
        state.configure("doc", true, false);
        assertFalse(state.canReveal(state.generation()));
        state.ready();
        assertTrue(state.canReveal(state.generation()));
        state.navigate(1);
        state.configure("next", false, true);
        assertFalse(state.canReveal(state.generation()));
        state.ready();
        assertTrue(state.canReveal(state.generation()));
        assertFalse(state.fullscreen());
    }

    @Test public void layoutInvalidationKeepsDocumentRequestAuthority() {
        BreadPresentationState state = ready();
        long navigation = state.navigationGeneration();
        state.layoutChanged();
        state.foreground(false, 10);
        assertTrue(state.authorizes(true, "doc", "doc", navigation));
        assertFalse(state.canReveal(state.generation()));
        state.foreground(true, 20);
        assertTrue(state.canReveal(state.generation()));
    }

    @Test public void failedPreparationCannotRevealButCanCloseItsOwnDocument() {
        BreadPresentationState state = ready();
        state.fail();
        state.ready();
        assertFalse(state.canReveal(state.generation()));
        assertEquals(BreadPresentationState.Phase.ERROR, state.phase());
        assertTrue(state.authorizes(true, "doc", "doc", state.navigationGeneration()));
        assertTrue(state.close());
    }

    @Test public void aRevealedPageDoesNotAcquireANewReadinessDeadlineOnRotation() {
        BreadPresentationState state = ready();
        state.painted(state.generation());
        assertEquals(BreadPresentationState.Phase.VISIBLE, state.phase());
        state.layoutChanged();
        assertFalse(state.tick(60000));
        state.painted(state.generation());
        assertEquals(BreadPresentationState.Phase.VISIBLE, state.phase());
    }
    @Test public void resolvedPolicyRequiresCurrentAcknowledgementAndOrderedVisibility() {
        BreadPresentationState state = new BreadPresentationState(30000, false);
        state.navigate(0);
        assertTrue(state.requestVisibility(true, null, 1, 1));
        assertFalse(state.effectiveVisibility());
        state.configure("doc", false, false);
        int revision = (int) state.policyRevision();
        assertTrue(state.policyResolved());
        assertFalse(state.effectiveVisibility());
        assertTrue(state.requestVisibility(true, revision, 2, 2));
        assertTrue(state.effectiveVisibility());
        state.configure("doc", false, false);
        assertEquals(revision, state.policyRevision());
        assertTrue(state.requestVisibility(false, null, 4, 3));
        assertFalse(state.requestVisibility(true, revision, 3, 4));
        assertFalse(state.effectiveVisibility());
        state.navigate(5);
        assertTrue(state.policyRevision() > revision);
        assertFalse(state.policyResolved());
        assertFalse(state.requestVisibility(true, revision, 5, 6));
        state.configure("next", true, true);
        assertTrue(state.requestVisibility(true, (int) state.policyRevision(), 6, 7));
        assertTrue(state.effectiveVisibility());
        state.close();
        assertFalse(state.requestVisibility(true, (int) state.policyRevision(), 7, 8));
    }

    @Test public void unresolvedErrorsResolveAndFallbackDoesNotAcquireAReadinessDeadline() {
        BreadPresentationState state = new BreadPresentationState(30000);
        state.navigate(0);
        long pending = state.policyRevision();
        state.visibility(false, 10000);
        assertFalse(state.tick(100000));
        state.visibility(true, 100000);
        assertTrue(state.tick(120000));
        assertTrue(state.policyResolved());
        assertTrue(state.policyRevision() > pending);
        assertFalse(state.effectiveVisibility());
        assertTrue(state.requestVisibility(true, (int) state.policyRevision(), 1, 120001));
        assertTrue(state.effectiveVisibility());
        state.navigate(120002);
        state.browserFallback();
        assertTrue(state.policyResolved());
        assertFalse(state.tick(999999));
        assertFalse(state.effectiveVisibility());
    }

}
