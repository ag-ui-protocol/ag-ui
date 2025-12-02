package com.agui.client.jsonpatch.lcs

/**
 * code extracted from Apache Commons Collections 4.1
 * Created by daely on 7/22/2016.
 */
object ListUtils {
    //-----------------------------------------------------------------------
    /**
     * Returns the longest common subsequence (LCS) of two sequences (lists).
     *
     * @param <E>  the element type
     * @param a  the first list
     * @param b  the second list
     * @return the longest common subsequence
     * @throws NullPointerException if either list is `null`
     * @since 4.0
    </E> */
    fun <E> longestCommonSubsequence(a: List<E>?, b: List<E>?): List<E> {
        return longestCommonSubsequence(a, b, DefaultEquator.defaultEquator())
    }

    /**
     * Returns the longest common subsequence (LCS) of two sequences (lists).
     *
     * @param <E>  the element type
     * @param a  the first list
     * @param b  the second list
     * @param equator  the equator used to test object equality
     * @return the longest common subsequence
     * @throws NullPointerException if either list or the equator is `null`
     * @since 4.0
    </E> */
    fun <E> longestCommonSubsequence(
        a: List<E>?, b: List<E>?,
        equator: Equator<in E>?
    ): List<E> {
        if (a == null || b == null) {
            throw NullPointerException("List must not be null")
        }
        if (equator == null) {
            throw NullPointerException("Equator must not be null")
        }
        val comparator: SequencesComparator<E> =
            SequencesComparator<E>(a, b, equator)
        val script: EditScript<E> = comparator.getScript()
        val visitor = LcsVisitor<E>()
        script.visit(visitor)
        return visitor.subSequence
    }

    /**
     * A helper class used to construct the longest common subsequence.
     */
    private class LcsVisitor<E> : CommandVisitor<E> {
        private val sequence: ArrayList<E>

        init {
            sequence = ArrayList<E>()
        }

        override fun visitInsertCommand(`object`: E) {}
        override fun visitDeleteCommand(`object`: E) {}
        override fun visitKeepCommand(`object`: E) {
            sequence.add(`object`)
        }

        val subSequence: List<E>
            get() = sequence
    }
}